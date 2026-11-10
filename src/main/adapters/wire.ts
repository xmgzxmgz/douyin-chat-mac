import type { Conversation, ConversationType, Friend, Message, MessageContent, MessageStatus, MessageType, Profile } from '@shared/types'

/**
 * 抖音 Web 端私信接口的线上数据结构（节选，仅保留客户端所需字段）。
 * 该层为「协议归一化层」：把线上字段（数字枚举、秒级时间、JSON 字符串载荷）
 * 转换为内部领域模型。Mock 适配器同样产出该结构，因此两条链路共用同一套映射逻辑。
 */
export interface RawUser {
  uid: string
  sec_uid?: string
  nickname: string
  unique_id?: string
  signature?: string
  avatar_thumb?: { url_list?: string[] }
  follower_count?: number
  following_count?: number
}

export interface RawMessage {
  msg_id: string
  conversation_id: string
  conversation_type?: number
  sender: string
  sender_nickname?: string
  sender_avatar?: string
  msg_type: number
  content: string
  create_time: number
  status?: number
  is_recalled?: number
  reply_to?: { msg_id: string; sender_nickname: string; preview: string }
}

export interface RawConversation {
  conversation_id: string
  conversation_type: number
  name?: string
  avatar?: string
  peer_uid?: string
  member_count?: number
  unread_count?: number
  mention_count?: number
  update_time: number
  is_pinned?: number
  is_muted?: number
  last_message?: RawMessage
}

export const WIRE_MSG_TYPE = {
  SYSTEM: 1,
  FILE: 3,
  STICKER: 5,
  TEXT: 7,
  SHARE: 8,
  VOICE: 17,
  IMAGE: 27
} as const

export const WIRE_STATUS = {
  SENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: 4
} as const

const MSG_TYPE_MAP: Record<number, MessageType> = {
  [WIRE_MSG_TYPE.SYSTEM]: 'system',
  [WIRE_MSG_TYPE.FILE]: 'file',
  [WIRE_MSG_TYPE.STICKER]: 'emoji',
  [WIRE_MSG_TYPE.TEXT]: 'text',
  [WIRE_MSG_TYPE.SHARE]: 'share',
  [WIRE_MSG_TYPE.VOICE]: 'voice',
  [WIRE_MSG_TYPE.IMAGE]: 'image'
}

const STATUS_MAP: Record<number, MessageStatus> = {
  [WIRE_STATUS.SENDING]: 'sending',
  [WIRE_STATUS.SENT]: 'sent',
  [WIRE_STATUS.DELIVERED]: 'delivered',
  [WIRE_STATUS.READ]: 'read',
  [WIRE_STATUS.FAILED]: 'failed'
}

const REVERSE_MSG_TYPE: Record<MessageType, number> = {
  system: WIRE_MSG_TYPE.SYSTEM,
  file: WIRE_MSG_TYPE.FILE,
  emoji: WIRE_MSG_TYPE.STICKER,
  text: WIRE_MSG_TYPE.TEXT,
  share: WIRE_MSG_TYPE.SHARE,
  voice: WIRE_MSG_TYPE.VOICE,
  image: WIRE_MSG_TYPE.IMAGE,
  video: WIRE_MSG_TYPE.SHARE
}

const REVERSE_STATUS: Record<MessageStatus, number> = {
  sending: WIRE_STATUS.SENDING,
  sent: WIRE_STATUS.SENT,
  delivered: WIRE_STATUS.DELIVERED,
  read: WIRE_STATUS.READ,
  failed: WIRE_STATUS.FAILED,
  recalled: WIRE_STATUS.SENT
}

/** 线上时间为秒级，内部统一毫秒级 */
export function toMs(value: number | string | undefined | null): number {
  if (value === null || value === undefined) return 0
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000)
}

export function toSeconds(ms: number): number {
  return Math.floor(ms / 1000)
}

export function parseConversationId(raw: string): { type: ConversationType; peerId: string } {
  // 0:1:<peerUid>:<selfUid>  |  0:2:<groupId>:<selfUid>
  const parts = String(raw).split(':')
  if (parts.length === 4) {
    return { type: parts[1] === '2' ? 'group' : 'private', peerId: parts[2] }
  }
  return { type: 'private', peerId: parts[parts.length - 1] ?? raw }
}

export function buildConversationId(type: ConversationType, peerId: string, selfId: string, groupId?: string): string {
  return type === 'group' ? `0:2:${groupId ?? peerId}:${selfId}` : `0:1:${peerId}:${selfId}`
}

export function pickAvatar(raw: RawUser | undefined): string {
  return raw?.avatar_thumb?.url_list?.[0] ?? ''
}

/** 文本/JSON 混合载荷解码：线上 text 为裸字符串，媒体类为 JSON 字符串 */
export function decodeContent(msgType: number, content: string): MessageContent {
  const type = MSG_TYPE_MAP[msgType] ?? 'text'
  if (type === 'text' || type === 'system') {
    const parsed = tryJson(content)
    if (parsed && typeof parsed === 'object' && typeof (parsed as MessageContent).text === 'string') {
      return { text: (parsed as MessageContent).text }
    }
    return { text: content ?? '' }
  }
  const parsed = tryJson(content)
  if (!parsed || typeof parsed !== 'object') {
    return type === 'image' ? { url: content } : { text: content ?? '' }
  }
  const c = parsed as Record<string, unknown>
  const pick = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = c[key]
      if (typeof v === 'string' && v) return v
    }
    return undefined
  }
  switch (type) {
    case 'image':
      return {
        url: pick(['url', 'origin_url', 'uri']) ?? '',
        thumbUrl: pick(['thumb_url', 'preview_url']),
        width: numberOr(c.width ?? c.w),
        height: numberOr(c.height ?? c.h)
      }
    case 'emoji':
      return { url: pick(['url', 'uri']) ?? '', emojiName: pick(['name', 'emoji_name']) }
    case 'voice':
      return {
        url: pick(['url', 'uri']) ?? '',
        duration: numberOr(c.duration ?? c.dur),
        text: pick(['transcript', 'text'])
      }
    case 'file':
      return {
        url: pick(['url', 'uri']) ?? '',
        name: pick(['name', 'file_name']) ?? '未命名文件',
        size: numberOr(c.size ?? c.file_size),
        mime: pick(['mime', 'mime_type'])
      }
    case 'share':
      return {
        url: pick(['url', 'share_url']) ?? '',
        title: pick(['title', 'desc']) ?? '分享内容',
        desc: pick(['desc', 'title']),
        thumbUrl: pick(['cover', 'thumb_url'])
      }
    default:
      return { text: content }
  }
}

export function encodeContent(type: MessageType, content: MessageContent): string {
  if (type === 'text' || type === 'system') return content.text ?? ''
  const map: Record<string, unknown> = {}
  if (type === 'image') {
    map.url = content.url
    map.width = content.width
    map.height = content.height
    if (content.thumbUrl) map.thumb_url = content.thumbUrl
  } else if (type === 'emoji') {
    map.url = content.url
    map.name = content.emojiName
  } else if (type === 'voice') {
    map.url = content.url
    map.duration = content.duration
    map.transcript = content.text
  } else if (type === 'file') {
    map.url = content.url
    map.name = content.name
    map.size = content.size
    map.mime = content.mime
  } else if (type === 'share' || type === 'video') {
    map.title = content.title
    map.desc = content.desc
    map.url = content.url
    map.cover = content.thumbUrl
  }
  return JSON.stringify(map)
}

export function normalizeProfile(raw: RawUser): Profile {
  return {
    id: raw.uid,
    nickname: raw.nickname,
    avatarUrl: pickAvatar(raw),
    uniqueId: raw.unique_id,
    signature: raw.signature,
    followerCount: raw.follower_count,
    followingCount: raw.following_count
  }
}

export function normalizeUser(raw: RawUser, accountId: string, online = false): Friend {
  return {
    id: raw.uid,
    accountId,
    nickname: raw.nickname,
    avatarUrl: pickAvatar(raw),
    uniqueId: raw.unique_id,
    signature: raw.signature,
    online,
    blocked: false,
    createdAt: Date.now()
  }
}

export function normalizeMessage(raw: RawMessage, accountId: string, selfId: string): Message {
  const type = MSG_TYPE_MAP[raw.msg_type] ?? 'text'
  const recalled = raw.is_recalled === 1
  return {
    id: raw.msg_id,
    clientId: raw.msg_id,
    conversationId: raw.conversation_id,
    accountId,
    senderId: raw.sender,
    senderName: raw.sender_nickname ?? raw.sender,
    senderAvatar: raw.sender_avatar,
    type,
    content: recalled ? { text: '' } : decodeContent(raw.msg_type, raw.content),
    createdAt: toMs(raw.create_time),
    status: recalled ? 'recalled' : STATUS_MAP[raw.status ?? WIRE_STATUS.SENT] ?? 'sent',
    isSelf: raw.sender === selfId,
    recalledAt: recalled ? toMs(raw.create_time) : undefined,
    replyTo: raw.reply_to
      ? { messageId: raw.reply_to.msg_id, senderName: raw.reply_to.sender_nickname, preview: raw.reply_to.preview }
      : undefined
  }
}

export function normalizeConversation(raw: RawConversation, accountId: string, selfId: string): Conversation {
  const parsed = parseConversationId(raw.conversation_id)
  const last = raw.last_message
  const preview = last ? previewOfType(MSG_TYPE_MAP[last.msg_type] ?? 'text', last.content) : ''
  return {
    id: raw.conversation_id,
    accountId,
    type: raw.conversation_type === 2 ? 'group' : parsed.type,
    title: raw.name ?? last?.sender_nickname ?? parsed.peerId,
    avatarUrl: raw.avatar ?? last?.sender_avatar ?? '',
    peerId: raw.peer_uid ?? parsed.peerId,
    memberCount: raw.member_count,
    lastMessageAt: toMs(raw.update_time || last?.create_time),
    lastMessagePreview: preview,
    unreadCount: Math.max(0, raw.unread_count ?? 0),
    mentionCount: Math.max(0, raw.mention_count ?? 0),
    pinned: raw.is_pinned === 1,
    muted: raw.is_muted === 1,
    hidden: false,
    draft: '',
    updatedAt: toMs(raw.update_time)
  }
}

export function previewOfType(type: MessageType, rawContent: string): string {
  const c = decodeContent(type === 'emoji' ? WIRE_MSG_TYPE.STICKER : type === 'image' ? WIRE_MSG_TYPE.IMAGE : REVERSE_MSG_TYPE[type] ?? WIRE_MSG_TYPE.TEXT, rawContent)
  switch (type) {
    case 'text':
      return (c.text ?? '').slice(0, 80)
    case 'image':
      return '[图片]'
    case 'emoji':
      return c.emojiName ? `[${c.emojiName}]` : '[表情]'
    case 'voice':
      return `[语音] ${c.duration ?? 0}"`
    case 'file':
      return `[文件] ${c.name ?? ''}`
    case 'share':
      return `[分享] ${c.title ?? ''}`
    case 'system':
      return c.text ?? '[系统消息]'
    default:
      return rawContent.slice(0, 80)
  }
}

export function toRawMessage(msg: Message): RawMessage {
  return {
    msg_id: msg.id,
    conversation_id: msg.conversationId,
    sender: msg.senderId,
    sender_nickname: msg.senderName,
    sender_avatar: msg.senderAvatar,
    msg_type: REVERSE_MSG_TYPE[msg.type],
    content: encodeContent(msg.type, msg.content),
    create_time: toSeconds(msg.createdAt),
    status: REVERSE_STATUS[msg.status],
    is_recalled: msg.status === 'recalled' ? 1 : 0,
    reply_to: msg.replyTo
      ? { msg_id: msg.replyTo.messageId, sender_nickname: msg.replyTo.senderName, preview: msg.replyTo.preview }
      : undefined
  }
}

function tryJson(input: string): unknown {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function numberOr(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
