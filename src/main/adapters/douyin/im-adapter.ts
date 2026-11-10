import type { Account, Conversation, Friend, Message, MessageContent, Profile, QrLoginState, QrLoginTicket, SessionStatus } from '@shared/types'
import { AppError } from '../../core/errors'
import type { Logger } from '../../core/notifier'
import type { ChatAdapter, Credentials, LoginResult, PullResult } from '../types'
import { decodeImResponse, encodeImRequest, readEnvelope, type ImConversation } from './im-protobuf'

const IM_BASE = 'https://imapi.douyin.com'
const WEB_BASE = 'https://www.douyin.com'
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>

export interface DouyinImOptions {
  cookie?: string
  userAgent?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** 诊断日志：只记录路径、状态码、包体大小，绝不记录 Cookie 与消息正文 */
  logger?: Logger
}

interface SelfProfile {
  uid: string
  nickname: string
  avatarUrl: string
  uniqueId?: string
}

/**
 * 抖音 IM 真实适配器（只读阶段）。
 *
 * 链路：Cookie 会话 → imapi.douyin.com（protobuf）→ 解码为领域模型
 * 当前已验证：初始同步（会话 + 最近消息）、增量同步。
 * 发送/撤回：接口已定位，但请求体字段尚未验证，显式返回 UNSUPPORTED，避免"发出去没人收到"。
 */
export class DouyinImAdapter implements ChatAdapter {
  readonly mode = 'douyin-web' as const
  readonly canSend = false
  private cookie = ''
  private userAgent: string
  private fetchImpl: FetchLike
  private timeoutMs: number
  private accountId = ''
  private selfId = ''
  private profile: SelfProfile | null = null
  private logger?: Logger
  private lastConversations: ImConversation[] = []

  constructor(opts: DouyinImOptions = {}) {
    this.cookie = opts.cookie ?? ''
    this.userAgent = opts.userAgent ?? DEFAULT_UA
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.timeoutMs = opts.timeoutMs ?? 15000
    this.logger = opts.logger
  }

  // ---------------- 传输 ----------------

  private extraHeaders: Record<string, string> = {}
  private metaExtra: Record<string, string> = {}
  private shape: { basic?: boolean; token?: string; extended?: boolean } = {}

  private async postProto(path: string, body: Buffer, extraHeaders: Record<string, string> = {}): Promise<Buffer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${IM_BASE}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/x-protobuf',
          'content-type': 'application/x-protobuf',
          origin: WEB_BASE,
          referer: `${WEB_BASE}/`,
          'user-agent': this.userAgent,
          cookie: this.cookie,
          ...this.extraHeaders,
          ...extraHeaders
        },
        body,
        signal: controller.signal
      })
      if (res.status === 401 || res.status === 403) {
        throw new AppError('AUTH_EXPIRED', '登录态被拒绝（401/403），请重新登录')
      }
      if (res.status >= 500) throw new AppError('SERVER', `IM 网关异常（HTTP ${res.status}）`)
      const buf = Buffer.from(await res.arrayBuffer())
      const env = readEnvelope(buf)
      if (env.status === undefined) {
        const text = buf.toString('utf8')
        const preview = /^[\x20-\x7e\u4e00-\u9fa5]*$/.test(text) ? text.slice(0, 240) : `hex:${buf.subarray(0, 12).toString('hex')}`
        this.logger?.warn(`IM ${path} 非预期响应：HTTP ${res.status} · ${buf.length}B · ${preview}`)
      }
      this.logger?.debug(
        `IM ${path} → HTTP ${res.status} · ${buf.length}B · cmd=${env.cmd} status=${env.status} ${env.message ?? ''}`
      )
      return buf
    } catch (err) {
      if (err instanceof AppError) throw err
      if ((err as Error).name === 'AbortError') throw new AppError('NETWORK', `IM 请求超时（>${this.timeoutMs}ms）`)
      throw new AppError('NETWORK', `IM 请求失败：${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
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
      const text = await res.text()
      const json = JSON.parse(text) as { user?: Record<string, unknown>; status_code?: number }
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

  /** 拉一次初始同步（会话 + 每会话最近消息） */
  private async pullInit(): Promise<{ envelope: ReturnType<typeof readEnvelope>; conversations: ImConversation[]; messages: Message[] }> {
    const body = encodeImRequest(
      { userAgent: this.userAgent, extra: this.metaExtra },
      { basic: this.shape.basic, token: this.shape.token, extended: this.shape.extended }
    )
    const buf = await this.postProto('/v1/message/get_message_by_init', body)
    const envelope = readEnvelope(buf)
    if (envelope.status !== 0) {
      const msg = envelope.message ?? `status=${envelope.status}`
      if (/session/i.test(msg)) throw new AppError('AUTH_EXPIRED', `IM 网关拒绝会话：${msg}`)
      throw new AppError('SERVER', `IM 网关返回异常：${msg}`)
    }
    const decoded = decodeImResponse(buf, this.selfId)
    this.logger?.debug(`IM init 解码：会话 ${decoded.conversations.length} · 消息 ${decoded.messages.length}`)
    if (!decoded.conversations.length) {
      this.logger?.warn(`IM init 无会话（selfId=${this.selfId ? '已识别' : '未识别'}）`)
    }
    return { envelope, ...decoded }
  }

  /**
   * 网关报 "empty token" 时，逐个试可能的 token 位置。
   * 只记录 status/message，不落任何凭据。
   */
  private async probeTokenVariants(): Promise<boolean> {
    const sid = /(?:^|;\s*)sessionid=([^;]+)/.exec(this.cookie)?.[1] ?? ''
    if (!sid) return false
    const ttwid = /(?:^|;\s*)ttwid=([^;]+)/.exec(this.cookie)?.[1] ?? ''
    const variants: Array<{
      name: string
      meta?: Record<string, string>
      header?: Record<string, string>
      extended?: boolean
      basic?: boolean
      token?: string
    }> = [
      { name: 'basic + token=ttwid', basic: true, token: ttwid },
      { name: 'basic + token=sessionid', basic: true, token: sid },
      { name: 'basic + token=0', basic: true, token: '0' },
      { name: 'basic', basic: true },
      { name: 'basic + extended', basic: true, extended: true },
      { name: 'basic + extended + token=ttwid', basic: true, extended: true, token: ttwid },
      { name: 'meta token', meta: { token: sid } },
      { name: 'header x-tt-token', header: { 'x-tt-token': sid } }
    ]
    for (const v of variants) {
      try {
        const buf = await this.postProto(
          '/v1/message/get_message_by_init',
          encodeImRequest(
            { userAgent: this.userAgent, extra: v.meta },
            { basic: v.basic, token: v.token, extended: v.extended }
          ),
          v.header ?? {}
        )
        const env = readEnvelope(buf)
        this.logger?.info(`IM 诊断[${v.name}] → status=${env.status} ${env.message ?? ''}`)
        if (env.status === 0) {
          this.metaExtra = v.meta ?? {}
          this.extraHeaders = v.header ?? {}
          this.shape = { basic: v.basic, token: v.token, extended: v.extended }
          this.logger?.info(`IM 诊断命中：${v.name}`)
          return true
        }
      } catch (err) {
        this.logger?.warn(`IM 诊断[${v.name}] 失败：${(err as Error).message}`)
      }
    }
    return false
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
    this.logger?.info(`真实模式登录：资料${profile ? '已获取' : '未获取'} · selfId ${this.selfId ? '已识别' : '未知'}`)

    // 用真实会话打一次 IM 网关，确认权限；失败则自动探测 token 位置
    let conversations: ImConversation[] = []
    try {
      conversations = (await this.pullInit()).conversations
    } catch (err) {
      if (!/empty token/i.test((err as Error).message)) throw err
      const ok = await this.probeTokenVariants()
      if (!ok) throw err
      conversations = (await this.pullInit()).conversations
    }
    if (!this.selfId) {
      this.selfId = inferSelfId(conversations)
    }
    this.lastConversations = conversations
    this.accountId = `acc_${this.selfId || 'im'}_im`

    this.logger?.info(`真实模式登录成功：${conversations.length} 个会话，selfId=${this.selfId || '未知'}`)
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
      await this.pullInit()
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
  }

  async fetchProfile(): Promise<Profile> {
    const p = this.profile ?? (await this.fetchSelf())
    if (!p) throw new AppError('AUTH_EXPIRED', '无法获取当前登录用户')
    return { id: p.uid, nickname: p.nickname, avatarUrl: p.avatarUrl, uniqueId: p.uniqueId }
  }

  // ---------------- 数据 ----------------

  async fetchConversations(): Promise<Conversation[]> {
    const { conversations, messages } = await this.pullInit()
    this.lastConversations = conversations
    if (!this.selfId) this.selfId = inferSelfId(conversations)
    return conversations.map((c) => {
      const last = messages
        .filter((m) => m.conversationId === c.id)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      return {
        id: c.id,
        accountId: this.accountId,
        type: c.type,
        title: c.title || '未命名会话',
        avatarUrl: c.avatarUrl,
        peerId: c.peerId,
        memberCount: c.memberCount,
        lastMessageAt: c.lastMessageAt || last?.createdAt || 0,
        lastMessagePreview: c.preview || previewOf(last),
        unreadCount: 0,
        mentionCount: 0,
        pinned: false,
        muted: false,
        hidden: false,
        draft: '',
        updatedAt: c.lastMessageAt || last?.createdAt || Date.now()
      }
    })
  }

  async pullUpdates(cursor: number): Promise<PullResult> {
    const { conversations, messages } = await this.pullInit()
    const fresh = messages
      .filter((m) => m.createdAt > cursor)
      .map((m) => ({ ...m, accountId: this.accountId }))
      .sort((a, b) => a.createdAt - b.createdAt)
    const next = fresh.length ? Math.max(...fresh.map((m) => m.createdAt)) : cursor
    return {
      conversations: conversations.map((c) => ({
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
        updatedAt: c.lastMessageAt
      })),
      messages: fresh,
      cursor: next
    }
  }

  async fetchHistory(): Promise<Message[]> {
    // /v1/message/get_by_conversation 的请求字段尚未验证，暂由本地缓存承担
    return []
  }

  async sendMessage(): Promise<Message> {
    throw new AppError(
      'UNSUPPORTED',
      '发送接口 /v1/message/send 的 protobuf 字段尚未验证，暂未启用。当前为只读模式。'
    )
  }

  async recallMessage(): Promise<void> {
    throw new AppError('UNSUPPORTED', '撤回接口尚未验证，暂未启用')
  }

  async sendTyping(): Promise<void> {
    /* noop */
  }

  async fetchFriends(): Promise<Friend[]> {
    const convs = this.lastConversations.length ? this.lastConversations : (await this.pullInit()).conversations
    this.lastConversations = convs
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
    /* noop */
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

function previewOf(m?: Message): string {
  if (!m) return ''
  switch (m.type) {
    case 'text':
      return (m.content.text ?? '').slice(0, 60)
    case 'image':
      return '[图片]'
    case 'share':
      return `[分享] ${m.content.title ?? ''}`
    case 'file':
      return `[文件] ${m.content.name ?? ''}`
    default:
      return ''
  }
}
