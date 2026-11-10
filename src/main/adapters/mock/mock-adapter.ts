import type { Account, Conversation, Friend, Message, Profile, QrLoginState, QrLoginTicket, SessionStatus } from '@shared/types'
import { AppError } from '../../core/errors'
import type { ChatAdapter, Credentials, LoginResult, PullResult } from '../types'
import {
  normalizeConversation,
  normalizeMessage,
  normalizeProfile,
  normalizeUser,
  toRawMessage,
  WIRE_MSG_TYPE,
  encodeContent
} from '../wire'
import { MockServer, avatar, type MockServerOptions } from './mock-server'

function mapError(err: unknown): never {
  const code = (err as { code?: string })?.code
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case 'AUTH_INVALID':
      throw new AppError('AUTH_INVALID', message)
    case 'AUTH_EXPIRED':
      throw new AppError('AUTH_EXPIRED', message)
    case 'NOT_FOUND':
      throw new AppError('NOT_FOUND', message)
    case 'NETWORK':
      throw new AppError('NETWORK', message)
    case 'RATE_LIMITED':
      throw new AppError('RATE_LIMITED', message)
    default:
      throw new AppError('SERVER', message)
  }
}

export class MockAdapter implements ChatAdapter {
  readonly mode = 'mock' as const
  private server: MockServer
  private selfId = ''
  private accountId = ''

  constructor(server?: MockServer, opts?: MockServerOptions) {
    this.server = server ?? new MockServer(opts)
    this.selfId = this.server.self.uid
  }

  get raw(): MockServer {
    return this.server
  }

  private async call<T>(fn: () => T): Promise<T> {
    await this.server.delay()
    try {
      this.server.guard()
      return fn()
    } catch (err) {
      mapError(err)
    }
  }

  async loginWithCookie(input: { cookie: string; userAgent?: string }): Promise<LoginResult> {
    const res = await this.call(() => this.server.login(input.cookie))
    const profile = normalizeProfile(res.user)
    this.selfId = profile.id
    this.accountId = `acc_${profile.id}_mock`
    const account: Account = {
      accountId: this.accountId,
      ...profile,
      mode: 'mock',
      createdAt: Date.now(),
      lastLoginAt: Date.now()
    }
    return {
      account,
      credentials: { cookie: input.cookie, userAgent: input.userAgent, savedAt: Date.now() },
      expiresAt: res.expiresAt
    }
  }

  async createQrLogin(): Promise<QrLoginTicket> {
    const qrId = this.server.createQr()
    return { qrId, imageDataUrl: qrPlaceholder(qrId), expiresAt: Date.now() + 90_000 }
  }

  async pollQrLogin(qrId: string): Promise<QrLoginState> {
    const state = this.server.pollQr(qrId)
    if (state === 'pending') return { state: 'pending' }
    if (state === 'scanned') return { state: 'scanned' }
    if (state === 'expired') return { state: 'expired' }
    const result = await this.loginWithCookie({ cookie: 'sessionid=mock_qr_session; ttwid=mock' })
    return { state: 'confirmed', session: await this.sessionInfo(result) }
  }

  async cancelQrLogin(): Promise<void> {
    /* mock 下无需处理 */
  }

  private async sessionInfo(result: LoginResult) {
    return {
      status: 'active' as SessionStatus,
      account: result.account,
      expiresAt: result.expiresAt,
      mode: this.mode,
      lastSyncAt: null
    }
  }

  async restore(credentials: Credentials): Promise<Account> {
    const res = await this.loginWithCookie({ cookie: credentials.cookie, userAgent: credentials.userAgent })
    return res.account
  }

  async validateSession(): Promise<{ status: SessionStatus; expiresAt: number | null }> {
    if (this.server.sessionExpired) return { status: 'expired', expiresAt: null }
    return { status: 'active', expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 }
  }

  async logout(): Promise<void> {
    this.server.sessionExpired = true
  }

  async fetchProfile(): Promise<Profile> {
    return this.call(() => normalizeProfile(this.server.self))
  }

  async fetchConversations(): Promise<Conversation[]> {
    return this.call(() =>
      this.server.conversationsFor().map((c) => normalizeConversation(c, this.accountId, this.selfId))
    )
  }

  async pullUpdates(cursor: number): Promise<PullResult> {
    return this.call(() => {
      const { items, cursor: next } = this.server.pull(cursor)
      return {
        messages: items.map((m) => normalizeMessage(m, this.accountId, this.selfId)),
        conversations: this.server
          .conversationsFor()
          .map((c) => normalizeConversation(c, this.accountId, this.selfId)),
        cursor: next
      }
    })
  }

  async fetchHistory(conversationId: string, before: number | undefined, limit: number): Promise<Message[]> {
    return this.call(() =>
      this.server.history(conversationId, before, limit).map((m) => normalizeMessage(m, this.accountId, this.selfId))
    )
  }

  async sendMessage(input: {
    conversationId: string
    type: Message['type']
    content: Message['content']
    clientId: string
    replyTo?: Message['replyTo']
    localId: string
  }): Promise<Message> {
    if (this.server.failNextSends > 0) {
      this.server.failNextSends -= 1
      await this.server.delay()
      throw new AppError('NETWORK', '发送失败：网络中断（故障注入）')
    }
    const msgType =
      input.type === 'image'
        ? WIRE_MSG_TYPE.IMAGE
        : input.type === 'emoji'
          ? WIRE_MSG_TYPE.STICKER
          : input.type === 'file'
            ? WIRE_MSG_TYPE.FILE
            : input.type === 'voice'
              ? WIRE_MSG_TYPE.VOICE
              : input.type === 'share' || input.type === 'video'
                ? WIRE_MSG_TYPE.SHARE
                : WIRE_MSG_TYPE.TEXT
    const raw = await this.call(() =>
      this.server.appendOutgoing(
        input.conversationId,
        encodeContent(input.type, input.content),
        msgType,
        input.clientId,
        input.replyTo
          ? { msg_id: input.replyTo.messageId, sender_nickname: input.replyTo.senderName, preview: input.replyTo.preview }
          : undefined
      )
    )
    const msg = normalizeMessage(raw, this.accountId, this.selfId)
    return { ...msg, clientId: input.clientId }
  }

  async recallMessage(messageId: string): Promise<void> {
    await this.call(() => {
      const convId = this.server.timeline.find((i) => i.msg.msg_id === messageId)?.msg.conversation_id ?? ''
      this.server.recall(convId, messageId)
    })
  }

  async sendTyping(): Promise<void> {
    /* no-op */
  }

  async markRead(conversationId: string): Promise<void> {
    await this.call(() => this.server.markRead(conversationId))
  }

  async fetchFriends(): Promise<Friend[]> {
    return this.call(() =>
      [...this.server.users.values()]
        .filter((u) => u.uid !== this.selfId && !u.uid.startsWith('g_'))
        .map((u) => normalizeUser(u, this.accountId, u.uid === 'u_2001'))
    )
  }

  async searchUsers(keyword: string): Promise<Friend[]> {
    const all = await this.fetchFriends()
    const k = keyword.trim().toLowerCase()
    if (!k) return []
    return all.filter(
      (f) => f.nickname.toLowerCase().includes(k) || (f.uniqueId ?? '').toLowerCase().includes(k) || f.id.includes(k)
    )
  }

  async addFriend(userId: string, remark?: string): Promise<Friend> {
    return this.call(() => {
      const raw = this.server.users.get(userId)
      if (!raw) throw Object.assign(new Error('用户不存在'), { code: 'NOT_FOUND' })
      const friend = normalizeUser(raw, this.accountId)
      if (remark) friend.remark = remark
      return friend
    })
  }

  async removeFriend(friendId: string): Promise<void> {
    await this.call(() => {
      if (!this.server.users.has(friendId)) throw Object.assign(new Error('好友不存在'), { code: 'NOT_FOUND' })
    })
  }

  async setBlocked(friendId: string, blocked: boolean): Promise<Friend> {
    return this.call(() => {
      const raw = this.server.users.get(friendId)
      if (!raw) throw Object.assign(new Error('好友不存在'), { code: 'NOT_FOUND' })
      const f = normalizeUser(raw, this.accountId)
      f.blocked = blocked
      return f
    })
  }

  dispose(): void {
    /* nothing */
  }
}

function qrPlaceholder(seed: string): string {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 100000
  const cells: string[] = []
  const size = 21
  const grid = 8
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (h = (h * 1103515245 + 12345) % 2147483647) % 3
      if (v === 0) cells.push(`<rect x="${x * grid}" y="${y * grid}" width="${grid}" height="${grid}" fill="#111"/>`)
    }
  }
  const finder = (x: number, y: number) =>
    `<rect x="${x * grid}" y="${y * grid}" width="${grid * 7}" height="${grid * 7}" fill="#111"/><rect x="${(x + 1) * grid}" y="${(y + 1) * grid}" width="${grid * 5}" height="${grid * 5}" fill="#fff"/><rect x="${(x + 2) * grid}" y="${(y + 2) * grid}" width="${grid * 3}" height="${grid * 3}" fill="#111"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 168 168"><rect width="168" height="168" fill="#fff"/>${cells.join('')}${finder(0, 0)}${finder(14, 0)}${finder(0, 14)}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export { avatar }
