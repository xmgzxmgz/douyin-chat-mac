import type {
  Account,
  Conversation,
  Friend,
  Message,
  MessageContent,
  Profile,
  QrLoginState,
  QrLoginTicket,
  SessionStatus
} from '@shared/types'
import { AppError } from '../../core/errors'
import type { Logger } from '../../core/notifier'
import type { ChatAdapter, Credentials, LoginResult, PullResult } from '../types'
import type { ImConversation } from './im-protobuf'
import { ImWebBridge } from './web-bridge'

const WEB_BASE = 'https://www.douyin.com'
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export interface DouyinPageOptions {
  logger?: Logger
  fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<Response>
  /** 页面捕获到新数据时回调，用于即时触发同步 */
  onData?: () => void
  partition?: string
}

interface SelfProfile {
  uid: string
  nickname: string
  avatarUrl: string
  uniqueId?: string
}

/**
 * 真实抖音适配器（页面传输版）。
 *
 * 数据来源不是自己构造的 HTTP 请求，而是页面自己发出的请求结果——
 * 因此不需要知道页面侧 token，也不需要在客户端维护签名算法。
 *
 * 只读：会话列表、历史消息窗口、增量同步。
 * 写入类能力（发送/撤回/已读上报）仍未启用，见 sendMessage 的说明。
 */
export class DouyinPageAdapter implements ChatAdapter {
  readonly mode = 'douyin-web' as const
  /** 只读同步：发送接口字段未验证，先不开放，避免「本地成功、对方收不到」 */
  readonly canSend = false

  private readonly bridge: ImWebBridge
  private readonly logger?: Logger
  private readonly fetchImpl: (url: string, init: Record<string, unknown>) => Promise<Response>
  private readonly onDataCb?: () => void
  private cookie = ''
  private userAgent = DEFAULT_UA
  private selfId = ''
  private accountId = ''
  private profile: SelfProfile | null = null
  private starting: Promise<void> | null = null
  private namesRefreshing = false
  private namesFetchedAt = 0

  constructor(opts: DouyinPageOptions = {}) {
    this.logger = opts.logger
    this.onDataCb = opts.onData
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as typeof this.fetchImpl)
    this.bridge = new ImWebBridge({
      logger: opts.logger,
      partition: opts.partition,
      onData: () => opts.onData?.()
    })
  }

  // ---------------- 鉴权 ----------------

  async loginWithCookie(input: { cookie: string; userAgent?: string }): Promise<LoginResult> {
    if (!/sessionid=/.test(input.cookie)) {
      throw new AppError('AUTH_INVALID', 'Cookie 中缺少 sessionid')
    }
    this.cookie = input.cookie
    if (input.userAgent) this.userAgent = input.userAgent

    const profile = await this.fetchSelf()
    this.profile = profile
    this.selfId = profile?.uid ?? ''
    this.bridge.setSelfId(this.selfId)
    this.logger?.info(`真实模式：资料${profile ? '已获取' : '未获取'} · selfId ${this.selfId ? '已识别' : '未知'}`)

    await this.ensureStarted()

    if (!this.selfId) {
      this.selfId = inferSelfId(this.bridge.snapshot().conversations)
      this.bridge.setSelfId(this.selfId)
    }
    this.accountId = `acc_${this.selfId || 'im'}_page`

    const s = this.bridge.stats()
    this.logger?.info(`真实模式登录成功：会话 ${s.conversations} · 消息 ${s.messages} · selfId=${this.selfId || '未知'}`)

    // 首屏就补昵称：login 返回后 ChatService 立刻拉会话，此时名字要已经就位
    await this.refreshNames(true)

    const p: Profile = {
      id: this.selfId || 'self',
      nickname: profile?.nickname ?? '我',
      avatarUrl: profile?.avatarUrl ?? '',
      uniqueId: profile?.uniqueId
    }
    const account: Account = {
      accountId: this.accountId,
      ...p,
      mode: this.mode,
      createdAt: Date.now(),
      lastLoginAt: Date.now()
    }
    return {
      account,
      credentials: { cookie: input.cookie, userAgent: this.userAgent, savedAt: Date.now() },
      expiresAt: null
    }
  }

  async createQrLogin(): Promise<QrLoginTicket> {
    throw new AppError('UNSUPPORTED', '真实模式请在应用内登录窗口完成扫码')
  }

  async pollQrLogin(): Promise<QrLoginState> {
    throw new AppError('UNSUPPORTED', '真实模式请在应用内登录窗口完成扫码')
  }

  async cancelQrLogin(): Promise<void> {
    /* noop */
  }

  async restore(credentials: Credentials): Promise<Account> {
    const res = await this.loginWithCookie({ cookie: credentials.cookie, userAgent: credentials.userAgent })
    return res.account
  }

  async validateSession(): Promise<{ status: SessionStatus; expiresAt: number | null }> {
    try {
      await this.ensureStarted()
      const s = this.bridge.stats()
      if (s.conversations === 0) return { status: 'expiring', expiresAt: null }
      return { status: 'active', expiresAt: null }
    } catch (err) {
      const e = AppError.from(err)
      if (e.code === 'AUTH_EXPIRED' || e.code === 'AUTH_REQUIRED') return { status: 'expired', expiresAt: null }
      return { status: 'expiring', expiresAt: null }
    }
  }

  async logout(): Promise<void> {
    this.cookie = ''
    this.profile = null
    await this.bridge.stop()
  }

  async fetchProfile(): Promise<Profile> {
    const p = this.profile ?? (await this.fetchSelf())
    if (!p) throw new AppError('AUTH_EXPIRED', '无法获取当前登录用户')
    return { id: p.uid, nickname: p.nickname, avatarUrl: p.avatarUrl, uniqueId: p.uniqueId }
  }

  // ---------------- 数据 ----------------

  async fetchConversations(): Promise<Conversation[]> {
    await this.ensureStarted()
    void this.refreshNames()
    return this.bridge.snapshot().conversations.map((c) => this.toConversation(c))
  }

  async pullUpdates(cursor: number): Promise<PullResult> {
    await this.ensureStarted()
    // 新会话可能还没昵称，顺带补上（内部有节流）
    void this.refreshNames()
    const snap = this.bridge.snapshot()
    const fresh = snap.messages
      .filter((m) => m.createdAt > cursor)
      .map((m) => ({ ...m, accountId: this.accountId }))
      .sort((a, b) => a.createdAt - b.createdAt)
    const next = fresh.length ? Math.max(...fresh.map((m) => m.createdAt)) : cursor
    return {
      conversations: snap.conversations.map((c) => this.toConversation(c)),
      messages: fresh,
      cursor: next
    }
  }

  async fetchHistory(conversationId: string, before: number | undefined, limit: number): Promise<Message[]> {
    await this.ensureStarted()
    const cutoff = before ?? Number.MAX_SAFE_INTEGER
    return this.bridge
      .snapshot()
      .messages.filter((m) => m.conversationId === conversationId && m.createdAt < cutoff)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((m) => ({ ...m, accountId: this.accountId }))
  }

  async sendMessage(): Promise<Message> {
    throw new AppError(
      'UNSUPPORTED',
      '发送仍未启用：/v1/message/send 的 protobuf 字段未验证。当前为只读同步，避免出现「本地显示已发送、对方实际收不到」。'
    )
  }

  async recallMessage(): Promise<void> {
    throw new AppError('UNSUPPORTED', '撤回接口尚未验证，暂未启用')
  }

  async sendTyping(): Promise<void> {
    /* noop */
  }

  async fetchFriends(): Promise<Friend[]> {
    await this.ensureStarted()
    const convs = this.bridge.snapshot().conversations
    const seen = new Map<string, Friend>()
    for (const c of convs) {
      if (c.type !== 'private' || !c.peerId || seen.has(c.peerId)) continue
      seen.set(c.peerId, {
        id: c.peerId,
        accountId: this.accountId,
        nickname: c.title || c.peerId,
        avatarUrl: c.avatarUrl,
        online: false,
        blocked: false,
        createdAt: Date.now()
      })
    }
    return [...seen.values()]
  }

  async searchUsers(): Promise<Friend[]> {
    return []
  }

  async addFriend(): Promise<Friend> {
    throw new AppError('UNSUPPORTED', '真实模式暂不支持添加好友')
  }

  async removeFriend(): Promise<void> {
    throw new AppError('UNSUPPORTED', '真实模式暂不支持删除好友')
  }

  async setBlocked(): Promise<Friend> {
    throw new AppError('UNSUPPORTED', '真实模式暂不支持拉黑')
  }

  dispose(): void {
    void this.bridge.stop()
  }

  // ---------------- 内部 ----------------

  private ensureStarted(): Promise<void> {
    if (this.bridge.alive) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.bridge.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  /**
   * 补昵称。protobuf 里只有 uid / sec_uid，昵称必须走页面的用户资料接口。
   * 每次最多查 60 个，节流 60s，避免频繁打扰页面。
   */
  async refreshNames(force = false): Promise<number> {
    if (this.namesRefreshing || !this.bridge.alive) return 0
    const now = Date.now()
    if (!force && now - this.namesFetchedAt < 60_000) return 0

    this.namesRefreshing = true
    let added = 0
    try {
      // 一次最多补 3 批（180 个），避免开屏时打太多请求
      const tried = new Set<string>()
      for (let round = 0; round < 3; round++) {
        const pending = this.bridge.pendingSecUids(40).filter((id) => !tried.has(id))
        if (round === 0) {
          this.logger?.info(
            `真实模式：补昵称检查 alive=${this.bridge.alive} 待补=${pending.length} 已知=${this.bridge.stats().names}`
          )
        }
        if (!pending.length) break
        for (const id of pending) tried.add(id)

        const items = await this.bridge.fetchUserNames(pending)
        if (!items.length) break
        added += this.bridge.applyProfiles(items)
      }
      this.namesFetchedAt = Date.now()
      if (added > 0) {
        this.logger?.info(`真实模式：补充昵称 ${added} 个`)
        this.onDataCb?.()
      }
      return added
    } finally {
      this.namesRefreshing = false
    }
  }

  private toConversation(c: ImConversation): Conversation {
    return {
      id: c.id,
      accountId: this.accountId,
      type: c.type,
      title: c.title || '未命名会话',
      avatarUrl: c.avatarUrl,
      peerId: c.peerId,
      memberCount: c.memberCount,
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.preview,
      unreadCount: 0,
      mentionCount: 0,
      pinned: false,
      muted: false,
      hidden: false,
      draft: '',
      updatedAt: c.lastMessageAt || Date.now()
    }
  }

  private async fetchSelf(): Promise<SelfProfile | null> {
    try {
      const res = await this.fetchImpl(
        `${WEB_BASE}/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web`,
        {
          headers: { 'user-agent': this.userAgent, referer: `${WEB_BASE}/`, cookie: this.cookie }
        }
      )
      const json = (await res.json()) as { user?: Record<string, unknown> }
      const u = json.user
      if (!u?.uid) return null
      const avatar = u.avatar_thumb as { url_list?: string[] } | undefined
      return {
        uid: String(u.uid),
        nickname: String(u.nickname ?? '我'),
        avatarUrl: avatar?.url_list?.[0] ?? '',
        uniqueId: u.unique_id ? String(u.unique_id) : undefined
      }
    } catch {
      return null
    }
  }
}

function inferSelfId(conversations: ImConversation[]): string {
  const counts = new Map<string, number>()
  for (const c of conversations) {
    if (c.type !== 'private') continue
    for (const p of c.participants) {
      if (p.id) counts.set(p.id, (counts.get(p.id) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

export type { MessageContent }
