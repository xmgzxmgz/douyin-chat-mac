import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, AppSettings, Conversation, Friend, Message } from '@shared/types'

export const DEFAULT_SETTINGS: AppSettings = {
  mode: 'mock',
  theme: 'light',
  sendKey: 'enter',
  autoLaunch: false,
  closeToTray: true,
  pollIntervalMs: 4000,
  historyPageSize: 30,
  notifications: {
    enabled: true,
    sound: true,
    showPreview: true,
    badge: true,
    dndEnabled: false,
    dndStart: '22:00',
    dndEnd: '08:00'
  }
}

export interface SessionRecord {
  accountId: string
  mode: AppSettings['mode']
  expiresAt: number | null
  lastSyncAt: number | null
}

interface State {
  version: number
  accounts: Record<string, Account>
  sessions: Record<string, SessionRecord>
  activeAccountId: string | null
  conversations: Record<string, Conversation>
  messages: Message[]
  friends: Record<string, Friend>
  settings: AppSettings
  cursors: Record<string, number>
}

function emptyState(): State {
  return {
    version: 1,
    accounts: {},
    sessions: {},
    activeAccountId: null,
    conversations: {},
    messages: [],
    friends: {},
    settings: structuredClone(DEFAULT_SETTINGS),
    cursors: {}
  }
}

export interface StoreOptions {
  /** 关闭磁盘持久化，用于测试 */
  inMemory?: boolean
  now?: () => number
}

/**
 * 轻量持久化层：单文件 JSON + 原子替换写入。
 * 选型说明见 docs/02：不引入 better-sqlite3 等原生模块，避免 Electron ABI 重编译，
 * 保证 `npm install && npm run dev` 在任意 Mac 上零编译通过。
 */
export class Store {
  readonly dir: string
  private state: State = emptyState()
  private readonly inMemory: boolean
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(dir: string, opts: StoreOptions = {}) {
    this.dir = dir
    this.inMemory = opts.inMemory ?? false
    if (!this.inMemory) mkdirSync(dir, { recursive: true })
    this.load()
  }

  private get file(): string {
    return join(this.dir, 'state.json')
  }

  load(): void {
    if (this.inMemory) return
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<State>
      this.state = {
        ...emptyState(),
        ...raw,
        settings: {
          ...DEFAULT_SETTINGS,
          ...(raw.settings ?? {}),
          notifications: { ...DEFAULT_SETTINGS.notifications, ...(raw.settings?.notifications ?? {}) }
        }
      }
    } catch {
      // 文件损坏时不阻塞启动：备份后以空状态继续
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      this.state = emptyState()
    }
  }

  flush(): void {
    if (this.inMemory) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty) return
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
    renameSync(tmp, this.file)
    this.dirty = false
  }

  private scheduleSave(): void {
    if (this.inMemory) return
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 200)
  }

  dispose(): void {
    this.flush()
  }

  // ---------- 账号 / 会话态 ----------
  upsertAccount(account: Account): void {
    this.state.accounts[account.accountId] = account
    this.state.activeAccountId = account.accountId
    this.scheduleSave()
  }

  listAccounts(): Account[] {
    return Object.values(this.state.accounts).sort((a, b) => b.lastLoginAt - a.lastLoginAt)
  }

  get activeAccountId(): string | null {
    return this.state.activeAccountId
  }

  set activeAccountId(id: string | null) {
    this.state.activeAccountId = id
    this.scheduleSave()
  }

  getAccount(id: string): Account | undefined {
    return this.state.accounts[id]
  }

  setSession(record: SessionRecord): void {
    this.state.sessions[record.accountId] = record
    this.scheduleSave()
  }

  getSession(accountId: string): SessionRecord | undefined {
    return this.state.sessions[accountId]
  }

  clearSession(accountId: string): void {
    delete this.state.sessions[accountId]
    this.state.activeAccountId = null
    this.scheduleSave()
  }

  getCursor(accountId: string): number {
    return this.state.cursors[accountId] ?? 0
  }

  setCursor(accountId: string, cursor: number): void {
    this.state.cursors[accountId] = cursor
    this.scheduleSave()
  }

  // ---------- 会话 ----------
  upsertConversations(accountId: string, conversations: Conversation[]): void {
    for (const conv of conversations) {
      const prev = this.state.conversations[conv.id]
      const alreadyRead = prev?.readAt !== undefined && conv.lastMessageAt <= prev.readAt
      this.state.conversations[conv.id] = {
        ...prev,
        ...conv,
        // 本地状态（置顶/免打扰/草稿/隐藏）不被远端覆盖
        pinned: conv.pinned || prev?.pinned || false,
        muted: conv.muted || prev?.muted || false,
        draft: prev?.draft ?? conv.draft ?? '',
        hidden: prev?.hidden ?? false,
        readAt: prev?.readAt,
        unreadCount: alreadyRead ? 0 : conv.unreadCount,
        mentionCount: alreadyRead ? 0 : conv.mentionCount,
        accountId
      }
    }
    this.scheduleSave()
  }

  listConversations(accountId: string): Conversation[] {
    return Object.values(this.state.conversations)
      .filter((c) => c.accountId === accountId && !c.hidden)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.lastMessageAt - a.lastMessageAt
      })
  }

  allConversations(accountId: string): Conversation[] {
    return Object.values(this.state.conversations).filter((c) => c.accountId === accountId)
  }

  getConversation(id: string): Conversation | undefined {
    return this.state.conversations[id]
  }

  patchConversation(id: string, patch: Partial<Conversation>): Conversation {
    const conv = this.state.conversations[id]
    if (!conv) throw Object.assign(new Error('会话不存在'), { code: 'NOT_FOUND' })
    const next = { ...conv, ...patch, updatedAt: Date.now() }
    this.state.conversations[id] = next
    this.scheduleSave()
    return next
  }

  // ---------- 消息 ----------
  appendMessage(message: Message): Message {
    const idx = this.state.messages.findIndex((m) => m.id === message.id || m.clientId === message.clientId)
    if (idx >= 0) {
      this.state.messages[idx] = { ...this.state.messages[idx], ...message }
      this.scheduleSave()
      return this.state.messages[idx]
    }
    this.state.messages.push(message)
    this.trimMessages(message.conversationId)
    this.scheduleSave()
    return message
  }

  /** 单会话最多保留 2000 条，防止 JSON 无限膨胀 */
  private trimMessages(conversationId: string): void {
    const list = this.state.messages.filter((m) => m.conversationId === conversationId)
    if (list.length <= 2000) return
    const remove = new Set(list.sort((a, b) => a.createdAt - b.createdAt).slice(0, list.length - 2000).map((m) => m.id))
    this.state.messages = this.state.messages.filter((m) => !remove.has(m.id))
  }

  /** 全量消息（仅用于清理类操作，勿在渲染路径调用） */
  listAllMessages(): Message[] {
    return this.state.messages
  }

  listMessages(conversationId: string, before: number | undefined, limit: number): Message[] {
    return this.state.messages
      .filter((m) => m.conversationId === conversationId && (before ? m.createdAt < before : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  getMessage(id: string): Message | undefined {
    return this.state.messages.find((m) => m.id === id)
  }

  getMessageByClientId(clientId: string): Message | undefined {
    return this.state.messages.find((m) => m.clientId === clientId)
  }

  updateMessage(id: string, patch: Partial<Message>): Message | undefined {
    const idx = this.state.messages.findIndex((m) => m.id === id || m.clientId === id)
    if (idx < 0) return undefined
    this.state.messages[idx] = { ...this.state.messages[idx], ...patch }
    this.scheduleSave()
    return this.state.messages[idx]
  }

  deleteMessage(id: string): void {
    this.state.messages = this.state.messages.filter((m) => m.id !== id && m.clientId !== id)
    this.scheduleSave()
  }

  // ---------- 好友 ----------
  upsertFriends(accountId: string, friends: Friend[]): void {
    for (const f of friends) {
      const prev = this.state.friends[f.id]
      this.state.friends[f.id] = {
        ...prev,
        ...f,
        accountId,
        remark: prev?.remark ?? f.remark,
        blocked: prev?.blocked ?? f.blocked
      }
    }
    this.scheduleSave()
  }

  listFriends(accountId: string): Friend[] {
    return Object.values(this.state.friends)
      .filter((f) => f.accountId === accountId)
      .sort((a, b) => (a.remark ?? a.nickname).localeCompare(b.remark ?? b.nickname, 'zh-Hans-CN'))
  }

  getFriend(id: string): Friend | undefined {
    return this.state.friends[id]
  }

  patchFriend(id: string, patch: Partial<Friend>): Friend {
    const f = this.state.friends[id]
    if (!f) throw Object.assign(new Error('好友不存在'), { code: 'NOT_FOUND' })
    const next = { ...f, ...patch }
    this.state.friends[id] = next
    this.scheduleSave()
    return next
  }

  removeFriend(id: string): void {
    delete this.state.friends[id]
    this.scheduleSave()
  }

  // ---------- 设置 ----------
  getSettings(): AppSettings {
    return this.state.settings
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = {
      ...this.state.settings,
      ...patch,
      notifications: { ...this.state.settings.notifications, ...(patch.notifications ?? {}) }
    }
    this.scheduleSave()
    return this.state.settings
  }

  /** 仅测试使用 */
  snapshot(): State {
    return structuredClone(this.state)
  }
}
