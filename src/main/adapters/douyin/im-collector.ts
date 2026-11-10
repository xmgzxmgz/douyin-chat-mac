import type { Message } from '@shared/types'
import {
  decodeConversationFields,
  decodeMessageFields,
  parseFields,
  type Field,
  type ImConversation
} from './im-protobuf'

/**
 * IM 响应的容错归并器。
 *
 * 为什么不绑定端点：真实网关有十几个路径（init / get_user_message / get_by_conversation /
 * stranger/get_conversation_list …），每个的 payload 嵌套层级都不同，而请求侧还差一个页面
 * 侧生成的 token。与其逐个逆向请求，不如**让页面自己去请求**，这里只按结构特征把
 * protobuf 里出现的会话和消息捞出来。
 *
 * 识别规则（来自真实抓包的字段语义）：
 *   会话：fn1 会话ID + fn50 详情（含 fn5 标题 / fn6 预览 / fn7 头像）
 *   消息：fn1 会话ID + fn3 消息ID + fn6 类型 + fn7 发送者 + fn8 JSON 内容
 */

export interface IngestStats {
  conversations: number
  messages: number
}

export interface CollectorSnapshot {
  conversations: ImConversation[]
  messages: Message[]
}

const MAX_DEPTH = 8

function isConversationNode(fields: Field[]): boolean {
  return (
    fields.some((f) => f.fn === 50 && f.wt === 2) &&
    fields.some((f) => f.fn === 1 && f.wt === 2) &&
    fields.some((f) => f.fn === 3 && f.wt === 0)
  )
}

function isMessageNode(fields: Field[]): boolean {
  const hasId = fields.some((f) => f.fn === 3 && f.wt === 0)
  const hasConv = fields.some((f) => f.fn === 1 && f.wt === 2)
  const hasType = fields.some((f) => f.fn === 6 && f.wt === 0)
  const hasPayload = fields.some((f) => (f.fn === 8 && f.wt === 2) || (f.fn === 9 && f.wt === 2))
  return hasId && hasConv && hasType && hasPayload
}

export class ImCollector {
  private readonly conversations = new Map<string, ImConversation>()
  private readonly messages = new Map<string, Message>()
  /** uid → 昵称 / 头像：会话包里只有 uid 与头像，昵称来自页面另一路的用户资料响应 */
  private readonly names = new Map<string, string>()
  private readonly avatars = new Map<string, string>()
  /** 消息里出现过的发送者 sec_uid（群聊成员昵称的来源） */
  private readonly senderSecUids = new Set<string>()
  private payloads = 0
  private bytes = 0
  private lastIngestAt = 0

  constructor(private readonly getSelfId: () => string = () => '') {}

  /**
   * 吸收 JSON 响应，抽取 uid → 昵称/头像。
   *
   * 不绑定端点：抖音网页会在多个 JSON 接口里下发用户资料（私信列表、用户信息、
   * 会话详情……），结构各不相同但都含 uid + nickname。按结构抽取比按端点解析更耐用。
   * 返回新增的昵称数量。
   */
  ingestJson(payload: unknown): number {
    const before = this.names.size

    const visit = (node: unknown, depth: number): void => {
      if (!node || typeof node !== 'object' || depth > 6) return
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1)
        return
      }
      const obj = node as Record<string, unknown>
      const id = pickUserId(obj)
      if (id) {
        const name = pickNickname(obj)
        if (name) this.names.set(id, name)
        const avatar = pickAvatar(obj)
        if (avatar) this.avatars.set(id, avatar)
      }
      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') visit(value, depth + 1)
      }
    }

    visit(payload, 0)
    return this.names.size - before
  }

  /**
   * 写入用户资料（昵称/头像），键同时支持 uid 与 sec_uid。
   * 昵称只能从页面的用户资料接口拿到——protobuf 响应里根本没有。
   */
  setProfiles(
    items: Array<{ uid?: string; secUid?: string; nickname?: string; avatar?: string }>
  ): number {
    const before = this.names.size
    for (const item of items) {
      const keys = [item.uid, item.secUid].filter((k): k is string => Boolean(k))
      if (!keys.length) continue
      if (item.nickname) for (const k of keys) this.names.set(k, item.nickname)
      if (item.avatar) for (const k of keys) this.avatars.set(k, item.avatar)
    }
    return this.names.size - before
  }

  /** 还没拿到昵称的会话（用于按需查询用户资料） */
  unresolvedSecUids(limit = 40): string[] {
    const out: string[] = []
    const push = (secUid: string): boolean => {
      if (!secUid || this.names.has(secUid) || out.includes(secUid)) return out.length >= limit
      out.push(secUid)
      return out.length >= limit
    }

    // 先补齐会话对方，再补齐群聊里出现过的发送者
    for (const c of this.conversations.values()) {
      if (c.type !== 'private' || !c.peerSecUid) continue
      if (this.names.has(c.peerId) || this.names.has(c.peerSecUid)) continue
      if (push(c.peerSecUid)) return out
    }
    for (const secUid of this.senderSecUids) {
      if (push(secUid)) return out
    }
    return out
  }

  /** 吸收一段 protobuf 响应；返回**新增**的会话/消息数量（重复条目不计） */
  ingest(buf: Buffer): IngestStats {
    const selfId = this.getSelfId()
    const stats: IngestStats = { conversations: 0, messages: 0 }

    const visit = (node: Buffer, depth: number): void => {
      if (depth > MAX_DEPTH || node.length < 4) return
      let fields: Field[]
      try {
        fields = parseFields(node)
      } catch {
        return
      }

      if (isConversationNode(fields)) {
        try {
          const conv = decodeConversationFields(fields, selfId)
          if (conv.id && !this.conversations.has(conv.id)) {
            this.conversations.set(conv.id, conv)
            stats.conversations++
          } else if (conv.id) {
            // 已存在时用新数据补齐缺失的标题/头像（增量包往往只带少量字段）
            const prev = this.conversations.get(conv.id)!
            this.conversations.set(conv.id, {
              ...prev,
              title: prev.title || conv.title,
              avatarUrl: prev.avatarUrl || conv.avatarUrl,
              preview: conv.preview || prev.preview,
              lastMessageAt: Math.max(prev.lastMessageAt, conv.lastMessageAt)
            })
          }
        } catch {
          /* 跳过异常会话 */
        }
        return
      }

      if (isMessageNode(fields)) {
        const msg = decodeMessageFields(fields, selfId, new Map())
        // 收集发送者 sec_uid：群聊成员的昵称只能靠它去查
        if (msg?.senderSecUid && msg.senderId !== selfId && this.senderSecUids.size < 4000) {
          this.senderSecUids.add(msg.senderSecUid)
        }
        // 无内容的系统消息（已撤回、状态变更等）不产生可读信息，直接丢弃，避免渲染成空气泡
        const emptySystem = msg?.type === 'system' && !(msg.content.text ?? '').trim()
        if (msg && msg.id && !emptySystem && !this.messages.has(msg.id)) {
          this.messages.set(msg.id, msg)
          stats.messages++
        }
        return
      }

      for (const f of fields) {
        if (f.wt === 2 && f.sub && f.sub.length >= 4) visit(f.sub, depth + 1)
      }
    }

    visit(buf, 0)
    this.payloads++
    this.bytes += buf.length
    if (stats.conversations || stats.messages) this.lastIngestAt = Date.now()
    return stats
  }

  /** 归并后的快照：会话预览/时间按最新消息回填，发送者名与 isSelf 按当前 selfId 解析 */
  snapshot(): CollectorSnapshot {
    const selfId = this.getSelfId()

    // 昵称优先级：JSON 用户资料 > 会话参与者字段 > uid
    const names = new Map<string, string>(this.names)
    for (const c of this.conversations.values()) {
      for (const p of c.participants) {
        if (p.name && !names.has(p.id)) names.set(p.id, p.name)
      }
    }

    const messages = [...this.messages.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((m) => ({
        ...m,
        senderName: names.get(m.senderId) ?? (selfId && m.senderId === selfId ? '我' : m.senderId),
        isSelf: Boolean(selfId) && m.senderId === selfId
      }))

    const latest = new Map<string, Message>()
    for (const m of messages) {
      const prev = latest.get(m.conversationId)
      if (!prev || m.createdAt >= prev.createdAt) latest.set(m.conversationId, m)
    }

    const conversations = [...this.conversations.values()].map((c) => {
      const last = latest.get(c.id)
      const newer = last && last.createdAt > c.lastMessageAt
      const peerName =
        c.type === 'private'
          ? (names.get(c.peerId) ?? (c.peerSecUid ? names.get(c.peerSecUid) : undefined) ?? '')
          : ''
      // 私信标题兜底：对方昵称 → 该会话最后一条对方消息的发送者名 → 用 uid 后四位区分
      const fromMessage =
        c.type === 'private' && !peerName
          ? [...messages].reverse().find((m) => m.conversationId === c.id && !m.isSelf && /\D/.test(m.senderName))
              ?.senderName ?? ''
          : ''
      const fallback = c.type === 'private' && c.peerId ? `抖音用户${c.peerId.slice(-4)}` : ''
      const peerAvatar =
        c.type === 'private'
          ? (this.avatars.get(c.peerId) ?? (c.peerSecUid ? this.avatars.get(c.peerSecUid) : undefined) ?? '')
          : ''
      return {
        ...c,
        title: c.title || peerName || fromMessage || fallback,
        avatarUrl: c.avatarUrl || peerAvatar,
        lastMessageAt: newer ? last.createdAt : c.lastMessageAt,
        preview: newer ? previewOf(last) : c.preview
      }
    })

    // 二次校正发送者名：昵称缺失时不要把 uid 摆在气泡上方。
    // 私信会话的对方昵称就等于会话标题，可以直接借用；群聊不能借用群名，只能退化成尾号。
    const peerTitleOf = new Map(
      conversations.filter((c) => c.type === 'private').map((c) => [c.id, c.title])
    )
    const resolved = messages.map((m) => {
      if (!/^\d+$/.test(m.senderName)) return m
      if (m.isSelf) return { ...m, senderName: '我' }
      const title = peerTitleOf.get(m.conversationId)
      return { ...m, senderName: title || `用户${m.senderId.slice(-4)}` }
    })

    return { conversations, messages: resolved }
  }

  since(cursor: number): Message[] {
    return this.snapshot().messages.filter((m) => m.createdAt > cursor)
  }

  stats(): {
    payloads: number
    bytes: number
    conversations: number
    messages: number
    names: number
    lastIngestAt: number
  } {
    return {
      payloads: this.payloads,
      bytes: this.bytes,
      conversations: this.conversations.size,
      messages: this.messages.size,
      names: this.names.size,
      lastIngestAt: this.lastIngestAt
    }
  }

  clear(): void {
    this.conversations.clear()
    this.messages.clear()
    this.names.clear()
    this.avatars.clear()
    this.senderSecUids.clear()
    this.payloads = 0
    this.bytes = 0
    this.lastIngestAt = 0
  }
}

function pickUserId(obj: Record<string, unknown>): string {
  // 只认明确的用户标识键，不用通用的 id（避免把消息 id / 会话 id 当用户）
  for (const key of ['uid', 'user_id', 'userId']) {
    const v = obj[key]
    if (typeof v === 'string' && /^\d{3,}$/.test(v)) return v
    if (typeof v === 'number' && v >= 100) return String(v)
  }
  return ''
}

function pickNickname(obj: Record<string, unknown>): string {
  for (const key of ['nickname', 'nick_name', 'nickName', 'display_name']) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim() && v.length <= 64 && !/^https?:\/\//.test(v)) return v.trim()
  }
  return ''
}

function pickAvatar(obj: Record<string, unknown>): string {
  const direct = obj.avatar_url
  if (typeof direct === 'string' && /^https?:\/\//.test(direct)) return direct
  const thumbs = obj.avatar_thumb ?? obj.avatar_medium ?? obj.avatar_larger
  const list = (thumbs as { url_list?: unknown } | undefined)?.url_list
  if (Array.isArray(list) && typeof list[0] === 'string') return list[0]
  return ''
}

function previewOf(m?: Message): string {
  if (!m) return ''
  switch (m.type) {
    case 'text':
      return (m.content.text ?? '').slice(0, 60)
    case 'image':
      return '[图片]'
    case 'share':
      return `[分享] ${m.content.title ?? ''}`.trim()
    case 'file':
      return `[文件] ${m.content.name ?? ''}`.trim()
    default:
      return ''
  }
}
