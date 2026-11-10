import type { RawConversation, RawMessage, RawUser } from '../wire'
import { WIRE_MSG_TYPE, WIRE_STATUS, buildConversationId, encodeContent } from '../wire'

/**
 * 本地模拟的「抖音私信后端」。
 * 目的：在没有真实账号/风控/网络的情况下，完整演练登录、同步、收发、撤回、好友等链路，
 * 并支持故障注入（延迟、限流、断网、会话过期），用于自动化测试与演示模式。
 */
export interface MockServerOptions {
  latencyMs?: number
  jitterMs?: number
  autoReply?: boolean
  now?: () => number
  selfId?: string
}

interface TimelineItem {
  seq: number
  msg: RawMessage
}

const REPLY_POOL = [
  '收到，我看下～',
  '哈哈哈哈这个也太好笑了',
  '晚点回你，在忙',
  '这个视频我刷到过，确实有意思',
  '好呀，那就这么定了',
  '你发的那张图我没加载出来，再发一次？',
  '刚看到，抱歉抱歉',
  '周末有空一起吃饭吗'
]

export class MockServer {
  readonly self: RawUser
  readonly users = new Map<string, RawUser>()
  conversations: RawConversation[] = []
  timeline: TimelineItem[] = []
  seq = 0
  latencyMs: number
  jitterMs: number
  autoReply: boolean
  sessionExpired = false
  failNextSends = 0
  rateLimitNext = false
  offline = false

  private readonly now: () => number
  private readonly qrTickets = new Map<string, { createdAt: number; state: 'pending' | 'scanned' | 'confirmed' | 'expired'; confirmedAt?: number }>()

  constructor(opts: MockServerOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.latencyMs = opts.latencyMs ?? 120
    this.jitterMs = opts.jitterMs ?? 60
    this.autoReply = opts.autoReply ?? true
    this.self = {
      uid: opts.selfId ?? 'self_1001',
      sec_uid: 'MS4wLjABAAAA_mock_self',
      nickname: '林一',
      unique_id: 'linyi_0912',
      signature: '记录生活里的小碎片',
      avatar_thumb: { url_list: [avatar('林一', '#FE2C55')] },
      follower_count: 1286,
      following_count: 342
    }
    this.users.set(this.self.uid, this.self)
    this.seed()
  }

  private seed(): void {
    const base = this.now()
    const people: Array<[string, string, string]> = [
      ['u_2001', '阿泽', '#4A7DFF'],
      ['u_2002', '小满', '#FF8A3D'],
      ['u_2003', '陈屿', '#12B886'],
      ['g_3001', '摄影交流群', '#8E6BFF']
    ]
    for (const [uid, nickname, color] of people) {
      this.users.set(uid, {
        uid,
        nickname,
        unique_id: uid.replace('u_', 'dy_'),
        signature: '这个人很懒，什么都没留下',
        avatar_thumb: { url_list: [avatar(nickname, color)] }
      })
    }

    const conversations: Array<{ peer: string; items: Array<[number, string]> }> = [
      {
        peer: 'u_2001',
        items: [
          [-1000 * 60 * 60 * 26, '昨天那个视频你看了吗'],
          [-1000 * 60 * 60 * 25, '看了，笑死'],
          [-1000 * 60 * 42, '晚上八点老地方？']
        ]
      },
      {
        peer: 'u_2002',
        items: [
          [-1000 * 60 * 60 * 5, '照片我修好啦，发你'],
          [-1000 * 60 * 60 * 5 + 2000, encodeContent('image', { url: 'mock://image/photo-01.jpg', width: 1080, height: 1440 })]
        ]
      },
      {
        peer: 'u_2003',
        items: [
          [-1000 * 60 * 60 * 50, '在吗'],
          [-1000 * 60 * 60 * 49, '在的']
        ]
      },
      {
        peer: 'g_3001',
        items: [
          [-1000 * 60 * 60 * 6, '周末有人去江边拍日落吗'],
          [-1000 * 60 * 60 * 5, '我我我，带上 35mm']
        ]
      }
    ]

    for (const c of conversations) {
      const peer = this.users.get(c.peer)!
      const convId = buildConversationId(c.peer.startsWith('g_') ? 'group' : 'private', c.peer, this.self.uid)
      const raws: RawMessage[] = c.items.map(([offset, content], i) => {
        const fromSelf = i % 3 === 1 && !c.peer.startsWith('g_')
        const msgType = content.startsWith('{') ? WIRE_MSG_TYPE.IMAGE : WIRE_MSG_TYPE.TEXT
        return {
          msg_id: `m_${c.peer}_${i}`,
          conversation_id: convId,
          sender: fromSelf ? this.self.uid : c.peer,
          sender_nickname: fromSelf ? this.self.nickname : peer.nickname,
          sender_avatar: fromSelf ? this.self.avatar_thumb?.url_list?.[0] : peer.avatar_thumb?.url_list?.[0],
          msg_type: msgType,
          content,
          create_time: Math.floor((base + offset) / 1000),
          status: WIRE_STATUS.READ
        }
      })
      for (const m of raws) this.appendMessage(m)
      const last = raws[raws.length - 1]
      this.conversations.push({
        conversation_id: convId,
        conversation_type: c.peer.startsWith('g_') ? 2 : 1,
        name: peer.nickname,
        avatar: peer.avatar_thumb?.url_list?.[0],
        peer_uid: c.peer,
        member_count: c.peer.startsWith('g_') ? 128 : undefined,
        unread_count: c.peer === 'u_2001' ? 2 : c.peer === 'g_3001' ? 4 : 0,
        mention_count: 0,
        update_time: last.create_time,
        is_pinned: c.peer === 'u_2001' ? 1 : 0,
        is_muted: c.peer === 'g_3001' ? 1 : 0,
        last_message: last
      })
    }
  }

  private appendMessage(msg: RawMessage): TimelineItem {
    const item = { seq: ++this.seq, msg }
    this.timeline.push(item)
    return item
  }

  async delay(): Promise<void> {
    const total = this.latencyMs + Math.floor(Math.random() * this.jitterMs)
    if (total > 0) await new Promise((r) => setTimeout(r, total))
  }

  guard(): void {
    if (this.offline) {
      const err = new Error('网络连接失败')
      ;(err as Error & { code?: string }).code = 'NETWORK'
      throw err
    }
    if (this.sessionExpired) {
      const err = new Error('登录状态已失效')
      ;(err as Error & { code?: string }).code = 'AUTH_EXPIRED'
      throw err
    }
    if (this.rateLimitNext) {
      this.rateLimitNext = false
      const err = new Error('请求过于频繁')
      ;(err as Error & { code?: string }).code = 'RATE_LIMITED'
      throw err
    }
  }

  login(cookie: string): { user: RawUser; expiresAt: number } {
    if (this.offline) {
      const err = new Error('网络连接失败')
      ;(err as Error & { code?: string }).code = 'NETWORK'
      throw err
    }
    if (!/sessionid=[^;]+/.test(cookie)) {
      const err = new Error('Cookie 中缺少 sessionid，无法完成登录')
      ;(err as Error & { code?: string }).code = 'AUTH_INVALID'
      throw err
    }
    if (/expired=1/.test(cookie)) {
      const err = new Error('该登录态已过期')
      ;(err as Error & { code?: string }).code = 'AUTH_EXPIRED'
      throw err
    }
    this.sessionExpired = false
    return { user: this.self, expiresAt: this.now() + 1000 * 60 * 60 * 24 * 7 }
  }

  createQr(): string {
    const qrId = `qr_${Math.random().toString(36).slice(2, 10)}`
    this.qrTickets.set(qrId, { createdAt: this.now(), state: 'pending' })
    return qrId
  }

  pollQr(qrId: string): 'pending' | 'scanned' | 'confirmed' | 'expired' {
    const t = this.qrTickets.get(qrId)
    if (!t) return 'expired'
    if (t.state === 'confirmed') return 'confirmed'
    if (t.state === 'scanned') return 'scanned'
    if (t.state === 'expired') return 'expired'
    const elapsed = this.now() - t.createdAt
    if (elapsed > 90_000) {
      t.state = 'expired'
      return 'expired'
    }
    // 演示节奏：1.2s 后模拟「已扫码」，3s 后模拟「已确认」
    if (elapsed > 3000) {
      t.state = 'confirmed'
      return 'confirmed'
    }
    if (elapsed > 1200) {
      t.state = 'scanned'
      return 'scanned'
    }
    return 'pending'
  }

  forceQrState(qrId: string, state: 'pending' | 'scanned' | 'confirmed' | 'expired'): void {
    const t = this.qrTickets.get(qrId)
    if (t) t.state = state
  }

  conversationsFor(): RawConversation[] {
    return [...this.conversations].sort((a, b) => b.update_time - a.update_time)
  }

  pull(cursor: number): { items: RawMessage[]; cursor: number } {
    const items = this.timeline.filter((i) => i.seq > cursor).map((i) => i.msg)
    return { items, cursor: this.seq }
  }

  history(conversationId: string, before: number | undefined, limit: number): RawMessage[] {
    const list = this.timeline
      .filter((i) => i.msg.conversation_id === conversationId)
      .map((i) => i.msg)
      .filter((m) => (before ? Math.floor(m.create_time * 1000) < before : true))
    return list.slice(-limit).reverse()
  }

  appendOutgoing(conversationId: string, content: string, msgType: number, clientId: string, replyTo?: RawMessage['reply_to']): RawMessage {
    const conv = this.conversations.find((c) => c.conversation_id === conversationId)
    if (!conv) {
      const err = new Error('会话不存在')
      ;(err as Error & { code?: string }).code = 'NOT_FOUND'
      throw err
    }
    const msg: RawMessage = {
      msg_id: clientId,
      conversation_id: conversationId,
      sender: this.self.uid,
      sender_nickname: this.self.nickname,
      sender_avatar: this.self.avatar_thumb?.url_list?.[0],
      msg_type: msgType,
      content,
      create_time: Math.floor(this.now() / 1000),
      status: WIRE_STATUS.SENT,
      reply_to: replyTo
    }
    this.appendMessage(msg)
    conv.update_time = msg.create_time
    conv.last_message = msg
    conv.unread_count = 0
    if (this.autoReply) this.scheduleAutoReply(conv)
    return msg
  }

  private scheduleAutoReply(conv: RawConversation): void {
    const peerId = conv.peer_uid ?? ''
    const peer = this.users.get(peerId)
    if (!peer) return
    const text = REPLY_POOL[Math.floor(Math.random() * REPLY_POOL.length)]
    setTimeout(() => {
      if (this.offline) return
      const msg: RawMessage = {
        msg_id: `m_auto_${this.seq + 1}`,
        conversation_id: conv.conversation_id,
        sender: peer.uid,
        sender_nickname: peer.nickname,
        sender_avatar: peer.avatar_thumb?.url_list?.[0],
        msg_type: WIRE_MSG_TYPE.TEXT,
        content: text,
        create_time: Math.floor(this.now() / 1000),
        status: WIRE_STATUS.DELIVERED
      }
      this.appendMessage(msg)
      conv.update_time = msg.create_time
      conv.last_message = msg
      conv.unread_count = (conv.unread_count ?? 0) + 1
    }, this.latencyMs + 400)
  }

  recall(conversationId: string, msgId: string): void {
    const item = this.timeline.find((i) => i.msg.msg_id === msgId)
    if (!item) {
      const err = new Error('消息不存在或已删除')
      ;(err as Error & { code?: string }).code = 'NOT_FOUND'
      throw err
    }
    item.msg.is_recalled = 1
    item.msg.content = ''
    const conv = this.conversations.find((c) => c.conversation_id === conversationId)
    if (conv?.last_message?.msg_id === msgId) {
      conv.last_message = { ...conv.last_message, is_recalled: 1, content: '' }
    }
  }

  markRead(conversationId: string): void {
    const conv = this.conversations.find((c) => c.conversation_id === conversationId)
    if (conv) {
      conv.unread_count = 0
      conv.mention_count = 0
    }
  }

  /** 测试/演示：模拟对方发来一条消息 */
  simulateIncoming(conversationId: string, text: string): RawMessage {
    const conv = this.conversations.find((c) => c.conversation_id === conversationId)
    if (!conv) throw Object.assign(new Error('会话不存在'), { code: 'NOT_FOUND' })
    const peerId = conv.peer_uid ?? ''
    const peer = this.users.get(peerId) ?? this.self
    const msg: RawMessage = {
      msg_id: `m_in_${this.seq + 1}`,
      conversation_id: conversationId,
      sender: peer.uid,
      sender_nickname: peer.nickname,
      sender_avatar: peer.avatar_thumb?.url_list?.[0],
      msg_type: WIRE_MSG_TYPE.TEXT,
      content: text,
      create_time: Math.floor(this.now() / 1000),
      status: WIRE_STATUS.DELIVERED
    }
    this.appendMessage(msg)
    conv.update_time = msg.create_time
    conv.last_message = msg
    conv.unread_count = (conv.unread_count ?? 0) + 1
    return msg
  }
}

/** 用内联 SVG 生成头像占位（避免任何外网依赖） */
export function avatar(name: string, color: string): string {
  const initial = name.slice(0, 1)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="60" fill="${color}"/><text x="50%" y="54%" font-size="52" font-family="-apple-system,PingFang SC" fill="#fff" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
