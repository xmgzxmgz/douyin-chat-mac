import type { Account, Conversation, Friend, Message, MessageContent, Profile, QrLoginState, QrLoginTicket, SessionStatus } from '@shared/types'
import { AppError } from '../../core/errors'
import type { ChatAdapter, Credentials, LoginResult, PullResult } from '../types'
import {
  buildConversationId,
  encodeContent,
  normalizeConversation,
  normalizeMessage,
  normalizeProfile,
  normalizeUser,
  toRawMessage,
  toSeconds,
  type RawConversation,
  type RawMessage,
  type RawUser
} from '../wire'
import { ENDPOINTS } from './endpoints'
import { DouyinHttpClient, type FetchLike } from './http-client'
import { UnsupportedSigner, type Signer } from './signature'

export interface DouyinAdapterOptions {
  cookie?: string
  userAgent?: string
  signer?: Signer
  fetchImpl?: FetchLike
  csrfToken?: string
  /** 测试用：请求最小间隔与休眠实现 */
  minIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
}

const MSG_TYPE_WIRE: Record<string, number> = {
  text: 7,
  image: 27,
  emoji: 5,
  file: 3,
  share: 8,
  video: 8,
  voice: 17,
  system: 1
}

function asArray<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (payload && typeof payload === 'object') {
    for (const key of keys) {
      const v = (payload as Record<string, unknown>)[key]
      if (Array.isArray(v)) return v as T[]
    }
  }
  return []
}

function pickOne<T>(payload: unknown, keys: string[]): T | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  for (const key of keys) {
    const v = (payload as Record<string, unknown>)[key]
    if (v && typeof v === 'object') return v as T
  }
  return undefined
}

/**
 * 抖音 Web 私信适配器。
 *
 * 请求链路：ChatAdapter → DouyinHttpClient（Cookie/签名/限流/重试/错误归一）→ 抖音 Web 接口
 * 响应链路：Raw* → wire.ts 归一化 → 领域模型
 *
 * 注意：私信接口未公开，端点与签名要求可能随时变化；未配置 Signer 时请求会以 UNSUPPORTED 失败，
 * 而不是发出无效请求触发风控。
 */
export class DouyinWebAdapter implements ChatAdapter {
  readonly mode = 'douyin-web' as const
  private client: DouyinHttpClient
  private accountId = ''
  private selfId = ''
  private selfProfile: Profile | null = null

  constructor(opts: DouyinAdapterOptions = {}) {
    this.client = new DouyinHttpClient({
      cookie: opts.cookie ?? '',
      userAgent: opts.userAgent,
      signer: opts.signer ?? new UnsupportedSigner(),
      fetchImpl: opts.fetchImpl,
      minIntervalMs: opts.minIntervalMs ?? 120,
      sleep: opts.sleep,
      maxRetries: opts.maxRetries
    })
  }

  get http(): DouyinHttpClient {
    return this.client
  }

  async loginWithCookie(input: { cookie: string; userAgent?: string }): Promise<LoginResult> {
    if (!/sessionid=/.test(input.cookie)) {
      throw new AppError('AUTH_INVALID', 'Cookie 中未找到 sessionid，请确认已复制完整的登录 Cookie')
    }
    this.client.updateCredentials(input.cookie, input.userAgent)
    const profile = await this.fetchProfile()
    this.selfId = profile.id
    this.accountId = `acc_${profile.id}_web`
    const account: Account = {
      accountId: this.accountId,
      ...profile,
      mode: this.mode,
      createdAt: Date.now(),
      lastLoginAt: Date.now()
    }
    return {
      account,
      credentials: { cookie: input.cookie, userAgent: input.userAgent, savedAt: Date.now() },
      expiresAt: null
    }
  }

  async createQrLogin(): Promise<QrLoginTicket> {
    throw new AppError(
      'UNSUPPORTED',
      '真实模式下暂仅支持「导入浏览器 Cookie」登录。扫码登录需要 passport 侧完整的风控链路，未做逆向实现。'
    )
  }

  async pollQrLogin(): Promise<QrLoginState> {
    throw new AppError('UNSUPPORTED', '真实模式未启用扫码登录')
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
      await this.fetchProfile()
      return { status: 'active', expiresAt: null }
    } catch (err) {
      const e = AppError.from(err)
      if (e.code === 'AUTH_EXPIRED' || e.code === 'AUTH_REQUIRED') return { status: 'expired', expiresAt: null }
      return { status: 'expiring', expiresAt: null }
    }
  }

  async logout(): Promise<void> {
    this.client.updateCredentials('')
    this.selfProfile = null
  }

  async fetchProfile(): Promise<Profile> {
    const payload = await this.client.get<{ user?: RawUser } & RawUser>(ENDPOINTS.profileSelf, {
      query: { aid: '6383', device_platform: 'webapp' }
    })
    const raw = (payload?.user ?? payload) as RawUser | undefined
    if (!raw?.uid) throw new AppError('AUTH_EXPIRED', '无法获取当前登录用户，登录态可能已失效')
    this.selfProfile = normalizeProfile(raw)
    return this.selfProfile
  }

  async fetchConversations(): Promise<Conversation[]> {
    const payload = await this.client.post<unknown>(ENDPOINTS.conversationList, {
      query: { count: 50, cursor: 0 },
      body: 'count=50&cursor=0'
    })
    return asArray<RawConversation>(payload, ['conversations', 'conversation_list', 'data']).map((c) =>
      normalizeConversation(c, this.accountId, this.selfId)
    )
  }

  async pullUpdates(cursor: number): Promise<PullResult> {
    const conversations = await this.fetchConversations()
    const messages: Message[] = []
    for (const conv of conversations.slice(0, 12)) {
      try {
        const history = await this.fetchHistory(conv.id, undefined, 20)
        for (const m of history) {
          if (m.createdAt > cursor) messages.push(m)
        }
      } catch (err) {
        const e = AppError.from(err)
        if (e.code === 'AUTH_EXPIRED' || e.code === 'AUTH_REQUIRED') throw e
      }
    }
    messages.sort((a, b) => a.createdAt - b.createdAt)
    // 同一消息可能因多个会话的历史窗口被重复返回，按 id 去重
    const unique = [...new Map(messages.map((m) => [m.id, m])).values()]
    const next = unique.length ? Math.max(...unique.map((m) => m.createdAt)) : cursor
    return { messages: unique, conversations, cursor: next }
  }

  async fetchHistory(conversationId: string, before: number | undefined, limit: number): Promise<Message[]> {
    const cursor = before ? toSeconds(before) : 0
    const payload = await this.client.post<unknown>(ENDPOINTS.messageHistory, {
      query: { conversation_id: conversationId, cursor, count: limit },
      body: `conversation_id=${encodeURIComponent(conversationId)}&cursor=${cursor}&count=${limit}`
    })
    const raws = asArray<RawMessage>(payload, ['messages', 'message_list', 'data'])
    return raws
      .map((m) => normalizeMessage(m, this.accountId, this.selfId))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async sendMessage(input: {
    conversationId: string
    type: Message['type']
    content: MessageContent
    clientId: string
    replyTo?: Message['replyTo']
    localId: string
  }): Promise<Message> {
    const body = new URLSearchParams({
      conversation_id: input.conversationId,
      msg_type: String(MSG_TYPE_WIRE[input.type] ?? 7),
      content: encodeContent(input.type, input.content),
      client_id: input.clientId,
      ext: JSON.stringify({ client_message_id: input.clientId })
    })
    if (input.replyTo) {
      body.set('reply_id', input.replyTo.messageId)
      body.set('reply_preview', input.replyTo.preview)
    }
    const payload = await this.client.post<unknown>(ENDPOINTS.messageSend, {
      query: { conversation_id: input.conversationId },
      body: body.toString()
    })
    const raw = pickOne<RawMessage>(payload, ['message', 'msg'])
    if (raw) {
      const normalized = normalizeMessage(raw, this.accountId, this.selfId)
      return { ...normalized, clientId: input.clientId }
    }
    // 接口只回执成功、不回消息体时，用本地构造保证 UI 一致
    return {
      id: input.clientId,
      clientId: input.clientId,
      conversationId: input.conversationId,
      accountId: this.accountId,
      senderId: this.selfId,
      senderName: this.selfProfile?.nickname ?? '我',
      senderAvatar: this.selfProfile?.avatarUrl,
      type: input.type,
      content: input.content,
      createdAt: Date.now(),
      status: 'sent',
      isSelf: true,
      replyTo: input.replyTo
    }
  }

  async recallMessage(messageId: string): Promise<void> {
    await this.client.post(ENDPOINTS.messageRecall, {
      body: `msg_id=${encodeURIComponent(messageId)}`
    })
  }

  async sendTyping(): Promise<void> {
    /* Web 端未暴露稳定的「正在输入」接口，此处降级为本地提示 */
  }

  async fetchFriends(): Promise<Friend[]> {
    const payload = await this.client.post<unknown>(ENDPOINTS.friendList, {
      query: { count: 100, cursor: 0 },
      body: 'count=100&cursor=0'
    })
    return asArray<RawUser>(payload, ['friends', 'user_list', 'data']).map((u) =>
      normalizeUser(u, this.accountId, false)
    )
  }

  async searchUsers(keyword: string): Promise<Friend[]> {
    const payload = await this.client.get<unknown>(ENDPOINTS.userSearch, {
      query: { keyword, count: 20, type: 1 }
    })
    return asArray<RawUser>(payload, ['user_list', 'users', 'data']).map((u) => normalizeUser(u, this.accountId))
  }

  async addFriend(userId: string, remark?: string): Promise<Friend> {
    await this.client.post(ENDPOINTS.friendAdd, {
      body: `user_id=${encodeURIComponent(userId)}&remark=${encodeURIComponent(remark ?? '')}`
    })
    return {
      id: userId,
      accountId: this.accountId,
      nickname: userId,
      remark,
      avatarUrl: '',
      online: false,
      blocked: false,
      createdAt: Date.now()
    }
  }

  async removeFriend(friendId: string): Promise<void> {
    await this.client.post(ENDPOINTS.friendRemove, { body: `user_id=${encodeURIComponent(friendId)}` })
  }

  async setBlocked(): Promise<Friend> {
    throw new AppError('UNSUPPORTED', '真实模式暂未接入「拉黑」接口，请在抖音 App 内操作')
  }

  dispose(): void {
    /* nothing */
  }

  /** 供测试与调试：用原始模型构造（避免依赖真实网络） */
  static _wire = { toRawMessage, buildConversationId, encodeContent }
}
