import type {
  Account,
  AdapterMode,
  AppEvent,
  AppSettings,
  Conversation,
  Friend,
  Message,
  MessageContent,
  QrLoginState,
  QrLoginTicket,
  SendMessageInput,
  SessionInfo,
  SessionStatus,
  SyncStatus
} from '@shared/types'
import { AppError } from './errors'
import { newId } from './id'
import { consoleLogger, NullNotifier, type Logger, type Notifier } from './notifier'
import { decideNotification, notificationBody } from './notification-policy'
import { SendQueue } from './send-queue'
import { SyncEngine } from './sync-engine'
import type { ChatAdapter, Credentials, PullResult } from '../adapters/types'
import type { Store } from '../store/repository'
import { previewOfType, encodeContent } from '../adapters/wire'

export interface CredentialVault {
  save(accountId: string, credentials: Credentials): Promise<void>
  load(accountId: string): Promise<Credentials | null>
  clear(accountId: string): Promise<void>
}

export interface ChatServiceDeps {
  store: Store
  createAdapter: (mode: AdapterMode) => ChatAdapter
  vault: CredentialVault
  notifier?: Notifier
  logger?: Logger
  now?: () => number
  syncIntervalMs?: number
  /** 发送队列参数（测试可注入零延迟实现） */
  sendOptions?: {
    maxAttempts?: number
    baseDelayMs?: number
    sleep?: (ms: number) => Promise<void>
  }
}

export interface BootstrapPayload {
  session: SessionInfo
  conversations: Conversation[]
  friends: Friend[]
  settings: AppSettings
  sync: SyncStatus
}

/**
 * 应用服务门面：串起「适配器 → 持久化 → 状态机 → 事件 → 通知」。
 * 不依赖 Electron，可在纯 Node 环境中被测试直接驱动。
 */
export class ChatService {
  private readonly store: Store
  private readonly createAdapter: (mode: AdapterMode) => ChatAdapter
  private readonly vault: CredentialVault
  private readonly notifier: Notifier
  private readonly logger: Logger
  private readonly now: () => number
  private readonly syncIntervalMs: number
  private readonly sendOptions: ChatServiceDeps['sendOptions']

  private adapter: ChatAdapter | null = null
  private queue: SendQueue | null = null
  private sync: SyncEngine | null = null
  private account: Account | null = null
  private status: SessionStatus = 'anonymous'
  private expiresAt: number | null = null
  private listeners = new Set<(event: AppEvent) => void>()
  private qrAdapter: ChatAdapter | null = null
  private qrTickets = new Map<string, QrLoginTicket>()
  private focused = true
  private activeConversationId: string | null = null
  private lastSync: SyncStatus = { phase: 'idle', lastSyncAt: null }
  /** 首次同步只补历史，不补通知（否则登录瞬间会弹出几十条历史消息提醒） */
  private firstSync = true

  constructor(deps: ChatServiceDeps) {
    this.store = deps.store
    this.createAdapter = deps.createAdapter
    this.vault = deps.vault
    this.notifier = deps.notifier ?? new NullNotifier()
    this.logger = deps.logger ?? consoleLogger
    this.now = deps.now ?? (() => Date.now())
    this.syncIntervalMs = deps.syncIntervalMs ?? this.store.getSettings().pollIntervalMs
    this.sendOptions = deps.sendOptions
  }

  // ---------------- 生命周期 ----------------

  async init(): Promise<void> {
    this.purgeUnsupportedFailures()
    this.sanitizeLinks()
    const accountId = this.store.activeAccountId
    if (!accountId) return
    const account = this.store.getAccount(accountId)
    if (!account) return
    const credentials = await this.vault.load(accountId)
    if (!credentials) {
      this.logger.warn('未找到已保存的登录凭据，需重新登录', accountId)
      return
    }
    const adapter = this.createAdapter(account.mode)
    try {
      await adapter.restore(credentials)
    } catch (err) {
      const e = AppError.from(err)
      this.logger.warn(`恢复登录态失败：${e.message}`)
      this.status = e.code === 'AUTH_EXPIRED' || e.code === 'AUTH_INVALID' ? 'expired' : 'anonymous'
      return
    }
    this.bind(adapter, account, null)
    try {
      await this.refreshFromServer()
    } catch (err) {
      this.logger.warn(`首次同步失败：${AppError.from(err).message}`)
    }
    this.startSync()
    this.emit({ type: 'session:changed', payload: this.getSession() })
  }

  dispose(): void {
    this.sync?.stop()
    this.queue?.stop()
    this.adapter?.dispose()
    this.listeners.clear()
  }

  private bind(adapter: ChatAdapter, account: Account, expiresAt: number | null): void {
    this.adapter?.dispose()
    this.queue?.stop()
    this.adapter = adapter
    this.account = account
    this.expiresAt = expiresAt
    this.status = 'active'
    this.firstSync = true
    this.store.upsertAccount(account)
    this.queue = new SendQueue({
      send: (input, clientId) => this.sendThrough(input, clientId),
      onSuccess: (clientId, message) => this.onSendSuccess(clientId, message),
      onFailure: (clientId, error) => this.onSendFailure(clientId, error),
      maxAttempts: this.sendOptions?.maxAttempts,
      baseDelayMs: this.sendOptions?.baseDelayMs,
      sleep: this.sendOptions?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    })
  }

  // ---------------- 鉴权 ----------------

  async loginWithCookie(input: { cookie: string; userAgent?: string }): Promise<SessionInfo> {
    const mode = this.store.getSettings().mode
    const adapter = this.createAdapter(mode)
    const result = await adapter.loginWithCookie(input)
    await this.vault.save(result.account.accountId, result.credentials)
    this.store.setSession({
      accountId: result.account.accountId,
      mode,
      expiresAt: result.expiresAt,
      lastSyncAt: this.now()
    })
    this.bind(adapter, result.account, result.expiresAt)
    await this.refreshFromServer()
    this.startSync()
    const session = this.getSession()
    this.emit({ type: 'session:changed', payload: session })
    this.emit({ type: 'toast', payload: { level: 'success', text: `已登录：${result.account.nickname}` } })
    this.logger.info(`登录成功 mode=${mode} account=${result.account.accountId}`)
    return session
  }

  async createQrLogin(): Promise<QrLoginTicket> {
    const adapter = this.createAdapter(this.store.getSettings().mode)
    this.qrAdapter = adapter
    const ticket = await adapter.createQrLogin()
    this.qrTickets.set(ticket.qrId, ticket)
    return ticket
  }

  async pollQrLogin(qrId: string): Promise<QrLoginState> {
    const adapter = this.qrAdapter
    if (!adapter) throw new AppError('VALIDATION', '二维码已失效，请重新获取')
    const state = await adapter.pollQrLogin(qrId)
    if (state.state === 'confirmed') {
      const session = state.session
      if (!session.account) throw new AppError('INTERNAL', '扫码登录未返回账号信息')
      await this.vault.save(session.account.accountId, { cookie: `qr:${qrId}`, savedAt: this.now() })
      this.store.setSession({
        accountId: session.account.accountId,
        mode: session.account.mode,
        expiresAt: session.expiresAt,
        lastSyncAt: this.now()
      })
      this.bind(adapter, session.account, session.expiresAt)
      this.qrAdapter = null
      await this.refreshFromServer()
      this.startSync()
      const info = this.getSession()
      this.emit({ type: 'session:changed', payload: info })
      return { state: 'confirmed', session: info }
    }
    return state
  }

  async cancelQrLogin(qrId: string): Promise<void> {
    await this.qrAdapter?.cancelQrLogin(qrId)
    this.qrTickets.delete(qrId)
    this.qrAdapter = null
  }

  async logout(): Promise<void> {
    const accountId = this.account?.accountId
    this.sync?.stop()
    this.sync = null
    this.queue?.stop()
    this.queue = null
    try {
      await this.adapter?.logout()
    } catch (err) {
      this.logger.warn(`登出接口失败（忽略）：${AppError.from(err).message}`)
    }
    this.adapter?.dispose()
    this.adapter = null
    this.account = null
    this.status = 'anonymous'
    this.expiresAt = null
    if (accountId) await this.vault.clear(accountId)
    if (accountId) this.store.clearSession(accountId)
    this.notifier.setBadge(0)
    this.emit({ type: 'session:changed', payload: this.getSession() })
    this.emit({ type: 'conversations:updated', payload: [] })
    this.logger.info('已退出登录')
  }

  async switchAccount(accountId: string): Promise<SessionInfo> {
    const account = this.store.getAccount(accountId)
    if (!account) throw new AppError('NOT_FOUND', '账号不存在')
    const credentials = await this.vault.load(accountId)
    if (!credentials) throw new AppError('AUTH_REQUIRED', '该账号凭据已失效，请重新登录')
    const adapter = this.createAdapter(account.mode)
    await adapter.restore(credentials)
    this.store.activeAccountId = accountId
    this.bind(adapter, account, this.store.getSession(accountId)?.expiresAt ?? null)
    await this.refreshFromServer()
    this.startSync()
    const session = this.getSession()
    this.emit({ type: 'session:changed', payload: session })
    this.emit({ type: 'conversations:updated', payload: this.listConversations() })
    this.emit({ type: 'friends:updated', payload: this.listFriends() })
    return session
  }

  getSession(): SessionInfo {
    if (!this.account) {
      return {
        status: 'anonymous',
        account: null,
        expiresAt: null,
        mode: this.store.getSettings().mode,
        lastSyncAt: null
      }
    }
    const expired = this.expiresAt !== null && this.expiresAt <= this.now()
    const status: SessionStatus = expired ? 'expired' : this.status
    return {
      status,
      account: this.account,
      expiresAt: this.expiresAt,
      mode: this.account.mode,
      lastSyncAt: this.store.getSession(this.account.accountId)?.lastSyncAt ?? null
    }
  }

  listAccounts(): Account[] {
    return this.store.listAccounts()
  }

  // ---------------- 会话 ----------------

  listConversations(): Conversation[] {
    if (!this.account) return []
    return this.store.listConversations(this.account.accountId)
  }

  findConversations(keyword: string): Conversation[] {
    const k = keyword.trim().toLowerCase()
    const list = this.listConversations()
    if (!k) return list
    return list.filter(
      (c) => c.title.toLowerCase().includes(k) || c.lastMessagePreview.toLowerCase().includes(k)
    )
  }

  setPinned(id: string, pinned: boolean): Conversation {
    const conv = this.store.patchConversation(id, { pinned })
    this.emitConversations()
    return conv
  }

  setMuted(id: string, muted: boolean): Conversation {
    const conv = this.store.patchConversation(id, { muted })
    this.emitConversations()
    return conv
  }

  setHidden(id: string, hidden: boolean): Conversation {
    const conv = this.store.patchConversation(id, { hidden })
    this.emitConversations()
    return conv
  }

  setDraft(id: string, draft: string): void {
    this.store.patchConversation(id, { draft })
  }

  markRead(id: string): Conversation {
    const conv = this.store.patchConversation(id, { unreadCount: 0, mentionCount: 0, readAt: this.now() })
    void this.adapter?.markRead?.(id).catch((err) => {
      this.logger.warn(`同步已读状态失败：${AppError.from(err).message}`)
    })
    this.emitConversations()
    this.refreshBadge()
    return conv
  }

  setActiveConversation(id: string | null): void {
    this.activeConversationId = id
  }

  setFocused(focused: boolean): void {
    this.focused = focused
  }

  // ---------------- 消息 ----------------

  async history(conversationId: string, before?: number, limit?: number): Promise<Message[]> {
    const pageSize = limit ?? this.store.getSettings().historyPageSize
    const local = this.store.listMessages(conversationId, before, pageSize)
    if (local.length >= pageSize || !this.adapter) return local
    try {
      const remote = await this.adapter.fetchHistory(conversationId, before, pageSize)
      for (const m of remote) {
        if (!this.store.getMessage(m.id)) this.store.appendMessage(m)
      }
      return this.store.listMessages(conversationId, before, pageSize)
    } catch (err) {
      this.logger.warn(`拉取历史消息失败：${AppError.from(err).message}`)
      return local
    }
  }

  /**
   * 发送消息：先落库为 sending（乐观 UI），再进串行队列；
   * 失败保留 failed 状态供手动重试，不静默丢弃。
   */
  async send(input: SendMessageInput): Promise<Message> {
    const account = this.requireAccount()
    // 只读适配器直接拒绝：不要先落一条「发送中」再失败，避免误导成网络问题
    if (this.adapter && this.adapter.canSend === false) {
      throw new AppError(
        'UNSUPPORTED',
        '当前是只读同步：真实模式的发送能力还没接（缺 /v1/message/send 的字段验证），这条消息没有发出'
      )
    }
    const conv = this.store.getConversation(input.conversationId)
    if (!conv) throw new AppError('NOT_FOUND', '会话不存在')
    if (input.type === 'text' && !(input.content.text ?? '').trim()) {
      throw new AppError('VALIDATION', '消息内容不能为空')
    }
    const clientId = newId('c')
    const createdAt = this.now()
    const optimistic: Message = {
      id: clientId,
      clientId,
      conversationId: input.conversationId,
      accountId: account.accountId,
      senderId: account.id,
      senderName: account.nickname,
      senderAvatar: account.avatarUrl,
      type: input.type,
      content: input.content,
      createdAt,
      status: 'sending',
      isSelf: true,
      replyTo: input.replyTo
    }
    this.store.appendMessage(optimistic)
    this.store.patchConversation(conv.id, {
      lastMessageAt: createdAt,
      lastMessagePreview: previewOfType(input.type, encodeContent(input.type, input.content)),
      draft: ''
    })
    this.emit({ type: 'message:updated', payload: optimistic })
    this.emitConversations()
    this.queue?.enqueue(input, clientId)
    return optimistic
  }

  async retry(clientId: string): Promise<Message> {
    const msg = this.store.getMessageByClientId(clientId)
    if (!msg) throw new AppError('NOT_FOUND', '消息不存在')
    if (msg.status !== 'failed') throw new AppError('CONFLICT', '仅失败的消息可以重试')
    const updated = this.store.updateMessage(clientId, {
      status: 'sending',
      errorCode: undefined,
      errorMessage: undefined
    })!
    const input: SendMessageInput = {
      conversationId: msg.conversationId,
      type: msg.type,
      content: msg.content,
      replyTo: msg.replyTo
    }
    this.queue?.retry(clientId, input)
    this.emit({ type: 'message:updated', payload: updated })
    return updated
  }

  async recall(messageId: string): Promise<Message> {
    const account = this.requireAccount()
    const msg = this.store.getMessage(messageId) ?? this.store.getMessageByClientId(messageId)
    if (!msg) throw new AppError('NOT_FOUND', '消息不存在')
    if (!msg.isSelf) throw new AppError('VALIDATION', '只能撤回自己发送的消息')
    if (this.now() - msg.createdAt > 2 * 60 * 1000) throw new AppError('VALIDATION', '超过 2 分钟，无法撤回')
    await this.adapter!.recallMessage(msg.id)
    const updated = this.store.updateMessage(msg.id, {
      status: 'recalled',
      content: { text: '' },
      recalledAt: this.now()
    })!
    // 被撤回的是否为该会话最新一条：用最新消息判断，避免秒级时间戳截断导致误判
    const latest = this.store.listMessages(msg.conversationId, undefined, 1)[0]
    if (latest && (latest.id === msg.id || latest.clientId === msg.clientId)) {
      this.store.patchConversation(msg.conversationId, { lastMessagePreview: '[消息已撤回]' })
    }
    this.emit({ type: 'message:updated', payload: updated })
    this.emitConversations()
    this.logger.info(`撤回消息 ${msg.id} (${account.nickname})`)
    return updated
  }

  deleteLocal(messageId: string): void {
    this.store.deleteMessage(messageId)
  }

  /**
   * 开发诊断：把一次「点开会话 / 输入草稿 / 真正发送」交给真实适配器执行，不写库。
   * 仅用于验证页面驱动链路，正常业务路径仍然是 send()。
   */
  async debugPageDrive(input: {
    title: string
    text: string
    mode: 'click' | 'draft' | 'send' | 'clear'
  }): Promise<unknown> {
    const adapter = this.adapter as unknown as
      | { debugPageDrive?: (i: typeof input) => Promise<unknown> }
      | null
    if (!adapter?.debugPageDrive) return { ok: false, reason: '当前适配器不支持页面驱动' }
    return adapter.debugPageDrive(input)
  }

  async sendTyping(conversationId: string): Promise<void> {
    await this.adapter?.sendTyping(conversationId)
  }

  private async sendThrough(input: SendMessageInput, clientId: string): Promise<Message> {
    if (!this.adapter) throw new AppError('AUTH_REQUIRED', '请先登录')
    return this.adapter.sendMessage({
      conversationId: input.conversationId,
      type: input.type,
      content: input.content,
      clientId,
      replyTo: input.replyTo,
      localId: clientId
    })
  }

  private onSendSuccess(clientId: string, message: Message): void {
    const prev = this.store.getMessageByClientId(clientId)
    const merged: Message = {
      ...(prev ?? message),
      ...message,
      id: message.id || clientId,
      clientId,
      status: message.status === 'sending' ? 'sent' : message.status,
      isSelf: true
    }
    this.store.updateMessage(clientId, merged)
    const conv = this.store.getConversation(merged.conversationId)
    if (conv && conv.lastMessageAt <= merged.createdAt) {
      this.store.patchConversation(conv.id, {
        lastMessageAt: merged.createdAt,
        lastMessagePreview: previewOfType(merged.type, encodeContent(merged.type, merged.content))
      })
    }
    this.emit({ type: 'message:updated', payload: merged })
    this.emitConversations()
  }

  private onSendFailure(clientId: string, error: AppError): void {
    const updated = this.store.updateMessage(clientId, {
      status: 'failed',
      errorCode: error.code,
      errorMessage: error.message
    })
    if (updated) this.emit({ type: 'message:updated', payload: updated })
    this.emit({ type: 'toast', payload: { level: 'error', text: `发送失败：${error.message}` } })
    this.logger.warn(`发送失败 clientId=${clientId} code=${error.code}`)
  }

  // ---------------- 好友 ----------------

  listFriends(): Friend[] {
    if (!this.account) return []
    return this.store.listFriends(this.account.accountId)
  }

  async searchFriends(keyword: string): Promise<Friend[]> {
    const k = keyword.trim().toLowerCase()
    const local = this.listFriends().filter(
      (f) =>
        (f.remark ?? f.nickname).toLowerCase().includes(k) ||
        (f.uniqueId ?? '').toLowerCase().includes(k) ||
        f.id.includes(k)
    )
    if (local.length || !this.adapter || !k) return local
    try {
      const remote = await this.adapter.searchUsers(keyword)
      this.store.upsertFriends(this.account!.accountId, remote)
      return remote
    } catch (err) {
      this.logger.warn(`搜索用户失败：${AppError.from(err).message}`)
      return []
    }
  }

  async addFriend(userId: string, remark?: string): Promise<Friend> {
    const account = this.requireAccount()
    const friend = await this.adapter!.addFriend(userId, remark)
    this.store.upsertFriends(account.accountId, [{ ...friend, remark: remark ?? friend.remark }])
    const saved = this.store.getFriend(friend.id) ?? friend
    this.emit({ type: 'friends:updated', payload: this.listFriends() })
    this.emit({ type: 'toast', payload: { level: 'success', text: `已添加好友 ${saved.nickname}` } })
    return saved
  }

  async removeFriend(friendId: string): Promise<void> {
    await this.adapter!.removeFriend(friendId)
    this.store.removeFriend(friendId)
    this.emit({ type: 'friends:updated', payload: this.listFriends() })
  }

  async setBlocked(friendId: string, blocked: boolean): Promise<Friend> {
    const updated = await this.adapter!.setBlocked(friendId, blocked)
    const saved = this.store.patchFriend(friendId, { blocked })
    this.emit({ type: 'friends:updated', payload: this.listFriends() })
    return { ...saved, ...updated, blocked }
  }

  setRemark(friendId: string, remark: string): Friend {
    const saved = this.store.patchFriend(friendId, { remark: remark.trim() || undefined })
    this.emit({ type: 'friends:updated', payload: this.listFriends() })
    return saved
  }

  // ---------------- 同步 ----------------

  startSync(): void {
    if (!this.adapter || !this.account) return
    this.sync?.stop()
    const accountId = this.account.accountId
    this.sync = new SyncEngine({
      pull: (cursor) => this.adapter!.pullUpdates(cursor),
      getCursor: () => this.store.getCursor(accountId),
      setCursor: (cursor) => this.store.setCursor(accountId, cursor),
      onPull: (result) => this.applyPull(result),
      onStatus: (status) => {
        this.lastSync = status
        if (this.account) {
          const rec = this.store.getSession(accountId)
          if (rec && status.lastSyncAt) {
            rec.lastSyncAt = status.lastSyncAt
            this.store.setSession(rec)
          }
        }
        this.emit({ type: 'sync:status', payload: status })
      },
      onAuthExpired: (error) => {
        this.status = 'expired'
        this.logger.warn(`同步检测到登录态失效：${error.message}`)
        this.emit({ type: 'session:changed', payload: this.getSession() })
        this.emit({ type: 'toast', payload: { level: 'warn', text: '登录状态已失效，请重新登录' } })
      },
      // 真实 IM 的 init 响应较大（含每个会话最近消息），轮询过频会浪费流量
      intervalMs:
        this.account?.mode === 'douyin-web'
          ? Math.max(30_000, this.syncIntervalMs)
          : this.syncIntervalMs
    })
    this.sync.start()
  }

  async syncNow(): Promise<SyncStatus> {
    this.requireAccount()
    if (!this.sync) this.startSync()
    if (!this.sync) throw new AppError('AUTH_REQUIRED', '请先登录')
    return this.sync.syncNow()
  }

  getSyncStatus(): SyncStatus {
    return this.lastSync
  }

  private async refreshFromServer(): Promise<void> {
    const account = this.requireAccount()
    const [conversations, friends] = await Promise.all([
      this.adapter!.fetchConversations(),
      this.adapter!.fetchFriends().catch(() => [] as Friend[])
    ])
    this.store.upsertConversations(account.accountId, conversations)
    this.store.upsertFriends(account.accountId, friends)
    this.emit({ type: 'conversations:updated', payload: this.listConversations() })
    this.emit({ type: 'friends:updated', payload: this.listFriends() })
    this.refreshBadge()
  }

  private async applyPull(result: PullResult): Promise<void> {
    const account = this.requireAccount()
    this.store.upsertConversations(account.accountId, result.conversations)
    const fresh = result.messages.filter((m) => !this.store.getMessage(m.id))
    for (const m of fresh) {
      this.store.appendMessage(m)
      const conv = this.store.getConversation(m.conversationId)
      if (conv && m.createdAt >= conv.lastMessageAt) {
        this.store.patchConversation(conv.id, {
          lastMessageAt: m.createdAt,
          lastMessagePreview: previewOfType(m.type, encodeContent(m.type, m.content))
        })
      }
    }
    if (fresh.length) {
      const activeId = this.activeConversationId
      if (activeId && fresh.some((m) => m.conversationId === activeId && !m.isSelf)) {
        this.markRead(activeId)
      }
      if (!this.firstSync) {
        for (const m of fresh.filter((x) => !x.isSelf)) this.maybeNotify(m)
      }
      this.emit({ type: 'messages:new', payload: fresh })
    }
    this.firstSync = false
    this.emit({ type: 'conversations:updated', payload: this.listConversations() })
    this.refreshBadge()
    // 好友是从会话反推的：昵称补全后要跟着刷新，否则好友页会一直停在「抖音用户xxxx」
    void this.refreshFriendsQuietly()
  }

  /** 把历史消息里非 http(s) 的链接清掉（例如 bitbrowser://），避免点一下就弹系统框 */
  private sanitizeLinks(): void {
    let fixed = 0
    for (const m of this.store.listAllMessages()) {
      const url = m.content?.url
      if (!url || /^https?:\/\//i.test(url)) continue
      this.store.updateMessage(m.id, { content: { ...m.content, url: undefined } })
      fixed++
    }
    if (fixed) this.logger.info(`已清理 ${fixed} 条非 http(s) 链接`)
  }

  /** 清掉旧版本在只读模式下产生的「发送失败」记录（会渲染成红色感叹号气泡） */
  private purgeUnsupportedFailures(): void {
    const stuck = this.store
      .listAllMessages()
      .filter((m) => m.status === 'failed' && (m.errorCode === 'UNSUPPORTED' || /只读|未启用/.test(m.errorMessage ?? '')))
    if (!stuck.length) return
    for (const m of stuck) this.store.deleteMessage(m.id)
    this.logger.info(`已清理 ${stuck.length} 条只读模式下的失败消息`)
  }

  private async refreshFriendsQuietly(): Promise<void> {
    if (!this.adapter || !this.account) return
    try {
      const friends = await this.adapter.fetchFriends()
      if (!friends.length) return
      this.store.upsertFriends(this.account.accountId, friends)
      this.emit({ type: 'friends:updated', payload: this.listFriends() })
    } catch {
      /* 好友不是关键路径，失败静默 */
    }
  }

  private maybeNotify(message: Message): void {
    const conv = this.store.getConversation(message.conversationId)
    if (!conv) return
    const settings = this.store.getSettings()
    const decision = decideNotification({
      message,
      conversation: conv,
      settings: settings.notifications,
      activeConversationId: this.activeConversationId,
      appFocused: this.focused,
      now: new Date(this.now())
    })
    this.logger.debug(`通知决策 ${decision.reason} conv=${conv.id}`)
    if (!decision.notify) return
    this.notifier.notify({
      title: conv.type === 'group' ? `${conv.title}（${message.senderName}）` : conv.title,
      body: notificationBody(message, settings.notifications.showPreview),
      conversationId: conv.id,
      silent: !decision.sound
    })
  }

  private refreshBadge(): void {
    if (!this.account) return this.notifier.setBadge(0)
    const total = this.store
      .allConversations(this.account.accountId)
      .filter((c) => !c.hidden)
      .reduce((sum, c) => sum + c.unreadCount, 0)
    this.notifier.setBadge(total)
  }

  // ---------------- 设置 & 导出 ----------------

  getSettings(): AppSettings {
    return this.store.getSettings()
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const next = this.store.updateSettings(patch)
    if (patch.pollIntervalMs && this.sync) {
      const ms =
        this.account?.mode === 'douyin-web' ? Math.max(30_000, patch.pollIntervalMs) : patch.pollIntervalMs
      this.sync.setIntervalMs(ms)
    }
    return next
  }

  snapshot(): BootstrapPayload {
    return {
      session: this.getSession(),
      conversations: this.listConversations(),
      friends: this.listFriends(),
      settings: this.getSettings(),
      sync: this.lastSync
    }
  }

  exportConversation(conversationId: string): { filename: string; content: string } {
    const conv = this.store.getConversation(conversationId)
    if (!conv) throw new AppError('NOT_FOUND', '会话不存在')
    const messages = this.store.listMessages(conversationId, undefined, 5000).slice().reverse()
    const lines = [
      `# ${conv.title}`,
      '',
      `导出时间：${new Date(this.now()).toLocaleString('zh-CN')}`,
      `消息条数：${messages.length}`,
      '',
      '---',
      ''
    ]
    for (const m of messages) {
      const time = new Date(m.createdAt).toLocaleString('zh-CN')
      const who = m.isSelf ? '我' : m.senderName
      const text =
        m.status === 'recalled'
          ? '[消息已撤回]'
          : m.type === 'text'
            ? (m.content.text ?? '')
            : previewOfType(m.type, encodeContent(m.type, m.content))
      lines.push(`**${who}** · ${time}`, '', text, '')
    }
    const safe = conv.title.replace(/[/\\:*?"<>|]/g, '_')
    return { filename: `${safe}-${new Date(this.now()).toISOString().slice(0, 10)}.md`, content: lines.join('\n') }
  }

  // ---------------- 事件 ----------------

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: AppEvent): void {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch (err) {
        this.logger.warn(`事件监听器异常：${(err as Error).message}`)
      }
    }
  }

  private emitConversations(): void {
    this.emit({ type: 'conversations:updated', payload: this.listConversations() })
    this.refreshBadge()
  }

  private requireAccount(): Account {
    if (!this.account) throw new AppError('AUTH_REQUIRED', '请先登录')
    return this.account
  }
}
