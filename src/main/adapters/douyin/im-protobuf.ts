import type { Message, MessageContent, MessageType } from '@shared/types'

/**
 * 抖音 IM（imapi.douyin.com）protobuf 编解码。
 *
 * 线上结构全部来自抓包实测（2026-11-10）：
 *   请求：field1=2001, field2=10020, field3="0.1.8", field4=空, field15=元信息 map
 *   响应：field1=cmd, field3=status, field4=status_msg, field6=扩展字段（字段号=cmd）
 *   消息：#1 会话ID #3 消息ID #4 时间(µs) #6 类型 #7 发送者 #8 JSON内容 #9 扩展map
 *   会话：#1 会话ID #3 类型(1私信/2群) #6 参与者 #50 详情(#4秒级时间 #5群名 #6预览 #7头像)
 */

export interface Field {
  fn: number
  wt: number
  v?: number
  /** 超过 2^53 的 varint 用它保精度（ID 类） */
  vs?: string
  sub?: Buffer
}

export function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } {
  let result = 0n
  let shift = 0n
  let i = offset
  while (i < buf.length) {
    const b = buf[i++]
    result |= BigInt(b & 0x7f) << shift
    if (!(b & 0x80)) return { value: result, next: i }
    shift += 7n
    if (shift > 63n) throw new Error('varint 溢出')
  }
  throw new Error('varint 截断')
}

export function parseFields(buf: Buffer): Field[] {
  const out: Field[] = []
  let i = 0
  while (i < buf.length) {
    const key = readVarint(buf, i)
    i = key.next
    const fn = Number(key.value >> 3n)
    const wt = Number(key.value & 7n)
    if (!fn) throw new Error('字段号为 0')
    if (wt === 0) {
      const v = readVarint(buf, i)
      i = v.next
      const num = Number(v.value)
      out.push({
        fn,
        wt,
        v: num,
        vs: v.value > BigInt(Number.MAX_SAFE_INTEGER) ? v.value.toString() : undefined
      })
    } else if (wt === 2) {
      const len = readVarint(buf, i)
      i = len.next
      const n = Number(len.value)
      if (i + n > buf.length) throw new Error('长度越界')
      out.push({ fn, wt, sub: buf.subarray(i, i + n) })
      i += n
    } else if (wt === 5) {
      if (i + 4 > buf.length) throw new Error('越界')
      out.push({ fn, wt, v: buf.readUInt32LE(i) })
      i += 4
    } else if (wt === 1) {
      if (i + 8 > buf.length) throw new Error('越界')
      out.push({ fn, wt, v: Number(buf.readBigUInt64LE(i)) })
      i += 8
    } else {
      throw new Error(`不支持的 wire type ${wt}`)
    }
  }
  return out
}

// ---------------- 编码 ----------------

function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  let v = BigInt(value)
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  bytes.push(Number(v))
  return Buffer.from(bytes)
}

function fieldVarint(fn: number, value: number): Buffer {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(value)])
}

function fieldBytes(fn: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(payload.length), payload])
}

function fieldString(fn: number, value: string): Buffer {
  return fieldBytes(fn, Buffer.from(value, 'utf8'))
}

export interface ImMeta {
  sessionAid?: string
  sessionDid?: string
  userAgent: string
  appName?: string
  referer?: string
  /** 追加到 field15 map 的键值（用于 token 探测） */
  extra?: Record<string, string>
}

/** field15 是 key/value 的 map，key 为字符串 */
function encodeMeta(meta: ImMeta): Buffer {
  const pairs: Array<[string, string]> = [
    ['session_aid', meta.sessionAid ?? '6383'],
    ['session_did', meta.sessionDid ?? '0'],
    ['app_name', meta.appName ?? 'douyin_pc'],
    ['priority_region', 'cn'],
    ['user_agent', meta.userAgent],
    ['cookie_enabled', 'true'],
    ['browser_language', 'zh-CN'],
    ['browser_platform', 'MacIntel'],
    ['browser_name', 'Chrome'],
    ['browser_version', meta.userAgent],
    ['browser_online', 'true'],
    ['screen_width', '1920'],
    ['screen_height', '1080'],
    ['referer', meta.referer ?? 'https://www.douyin.com/'],
    ['timezone_name', 'Asia/Shanghai'],
    ['deviceId', '0'],
    ['is-retry', '0']
  ]
  const all = meta.extra ? [...pairs, ...Object.entries(meta.extra)] : pairs
  return Buffer.concat(all.map(([k, v]) => fieldBytes(15, Buffer.concat([fieldString(1, k), fieldString(2, v)]))))
}

/**
 * 构造 IM 请求体。
 * withMeta=false 时退化为 15 字节最小信封（实测可被网关接受并进入会话校验）。
 */
export interface ImRequestShape {
  withMeta?: boolean
  /** 抓包里的 #5/#6/#7/#9 基础字段 */
  basic?: boolean
  /** 抓包里的 #8（疑似 token） */
  token?: string
  /** 抓包尾部的 #18/#21/#22 */
  extended?: boolean
}

export function encodeImRequest(meta: ImMeta, shape: ImRequestShape | boolean = {}): Buffer {
  const opts: ImRequestShape = typeof shape === 'boolean' ? { withMeta: shape } : shape
  const head = Buffer.concat([
    fieldVarint(1, 2001),
    fieldVarint(2, 10020),
    fieldString(3, '0.1.8'),
    fieldBytes(4, Buffer.alloc(0))
  ])
  if (opts.withMeta === false) return head

  const basic = opts.basic
    ? Buffer.concat([
        fieldVarint(5, 3),
        fieldVarint(6, 1),
        fieldString(7, '0d50935:feat/pc-im-group'),
        opts.token ? fieldString(8, opts.token) : fieldBytes(8, Buffer.alloc(0)),
        fieldString(9, '0')
      ])
    : Buffer.alloc(0)

  const tail = opts.extended
    ? Buffer.concat([
        fieldVarint(18, 1),
        fieldBytes(21, fieldString(1, 'douyin_web')),
        fieldString(22, 'web_sdk')
      ])
    : Buffer.alloc(0)

  return Buffer.concat([
    head,
    basic,
    fieldString(11, meta.appName ?? 'douyin_pc'),
    fieldString(14, '360000'),
    encodeMeta(meta),
    tail
  ])
}

// ---------------- 响应信封 ----------------

export interface ImEnvelope {
  cmd?: number
  status?: number
  message?: string
}

export function readEnvelope(buf: Buffer): ImEnvelope {
  const out: ImEnvelope = {}
  let fields: Field[]
  try {
    fields = parseFields(buf)
  } catch {
    return out
  }
  for (const f of fields) {
    if (f.fn === 1 && f.wt === 0) out.cmd = f.v
    if (f.fn === 3 && f.wt === 0) out.status = f.v
    if (f.fn === 4 && f.wt === 2) out.message = f.sub?.toString('utf8')
  }
  return out
}

// ---------------- 业务解码 ----------------

export interface ImParticipant {
  id: string
  name: string
  avatar: string
  /** 参与者 #5 字段：加密后的用户 ID，用于向用户资料接口查询昵称 */
  secUid: string
}

export interface ImConversation {
  id: string
  type: 'private' | 'group'
  title: string
  preview: string
  avatarUrl: string
  peerId: string
  /** 私信对方/群主的 sec_uid（详情 #13），用于查昵称 */
  peerSecUid: string
  lastMessageAt: number
  memberCount: number
  participants: ImParticipant[]
}

export interface ImDecoded {
  conversations: ImConversation[]
  messages: Message[]
}

/**
 * 消息类型映射（来自真实抓包的消息 #6 字段）。
 * 这里把「抖音的消息类型」翻译成客户端的 8 种展示类型；无法一一对应的按最接近的归类。
 */
const IM_TYPE: Record<number, MessageType> = {
  1: 'system', // 系统提示
  5: 'emoji', // 表情 / 贴纸（自带图片 url）
  7: 'text',
  8: 'share', // 视频 / 图文分享
  15: 'emoji', // 打招呼贴纸
  17: 'voice',
  21: 'share', // 直播分享
  25: 'share', // 名片（用户卡片）
  26: 'share', // 小程序 / 卡片
  27: 'image',
  73: 'system', // 通话记录
  77: 'share', // 图文 / 图集
  83: 'share', // 评论分享
  105: 'share', // 视频 + 评论
  110: 'share', // 直播间卡片
  1001: 'system' // 群系统消息
}

/** 分享卡片的角标文案 */
const CARD_KIND: Record<number, string> = {
  8: '视频',
  21: '直播',
  25: '名片',
  26: '卡片',
  77: '图文',
  83: '评论',
  105: '视频',
  110: '直播'
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * 取一个可用的 URL 值。抖音的封面/头像字段有三种形态：
 *   字符串、"数组"、以及最常见的 `{ url_list: [...] }` 嵌套结构。
 */
function pickUrlValue(v: unknown): string {
  const ok = (x: unknown): x is string => typeof x === 'string' && /^(https?:\/\/|data:image\/)/.test(x)
  if (ok(v)) return v
  if (Array.isArray(v) && ok(v[0])) return v[0]
  if (v && typeof v === 'object') {
    const list = (v as { url_list?: unknown }).url_list
    if (Array.isArray(list) && ok(list[0])) return list[0]
  }
  return ''
}

function firstUrl(content: Record<string, unknown> | null, keys: string[]): string {
  if (!content) return ''
  for (const key of keys) {
    const found = pickUrlValue(content[key])
    if (found) return found
  }
  return ''
}

/** 去掉服务端加的「[分享视频]」之类前缀，标题只留正文 */
function stripSharePrefix(text: string): string {
  return text.replace(/^\s*\[(?:分享视频|分享图文|分享图片|分享|视频|图文|图片)\]\s*/, '').trim()
}

/** 按消息类型从 content JSON 里抽取展示内容 */
export function buildContent(
  rawType: number,
  type: MessageType,
  content: Record<string, unknown> | null
): MessageContent {
  if (!content) return { text: '' }

  switch (type) {
    case 'text':
      return { text: asString(content.text) }

    case 'emoji': {
      const name = asString(content.danmaku_text) || asString(content.display_name) || '表情'
      return {
        text: name,
        emojiName: name,
        url: firstUrl(content, ['url', 'light_url', 'cover_url', 'stickers', 'joker_stickers']),
        width: Number(content.width) || undefined,
        height: Number(content.height) || undefined
      }
    }

    case 'image':
      return {
        url: firstUrl(content, ['url_list', 'inline_pic', 'origin_url', 'url', 'big_url', 'cover_url']),
        width: Number(content.width ?? content.cover_width) || undefined,
        height: Number(content.height ?? content.cover_height) || undefined
      }

    case 'voice': {
      // 线上 duration 是毫秒；直接显示会变成「3400″」
      const raw = Number(content.duration ?? 0)
      const seconds = raw > 300 ? Math.round(raw / 1000) : Math.round(raw)
      return {
        url: firstUrl(content, ['resource_url', 'url']),
        duration: seconds || undefined
      }
    }

    case 'share': {
      const itemId =
        asString(content.itemId) || asString(content.item_id) || asString(content.aweme_id) || ''
      const commentUrl = pickUrlValue(content.comment_url)
      // 只认 http(s)：抖音的 schema 字段可能是 bitbrowser:// 这类自定义协议，
      // 直接丢给系统会弹出「未设定用来打开此 URL 的应用程序」
      const rawLink =
        commentUrl ||
        pickUrlValue(content.share_url) ||
        pickUrlValue(content.link_url) ||
        asString(content.schema)
      const isWebLink = /^https?:\/\//.test(rawLink)
      const shareUrl = (isWebLink ? rawLink : '') || (itemId ? `https://www.douyin.com/video/${itemId}` : '')

      const rawTitle =
        asString(content.content_title) ||
        asString(content.aweme_title) ||
        asString(content.content_name) ||
        asString(content.name) ||
        asString(content.description) ||
        asString(content.comment)
      const title = stripSharePrefix(rawTitle) || CARD_KIND[rawType] || '分享内容'

      // 描述单独一行的意义：只有和标题不同才显示，否则卡片会重复同一段话
      let desc = stripSharePrefix(
        asString(content.comment) ||
          asString(content.description) ||
          asString(content.content_name) ||
          asString(content.desc)
      )
      if (!desc || desc === title || title.includes(desc) || desc.includes(title)) desc = ''

      return {
        title,
        desc: desc || undefined,
        coverUrl: firstUrl(content, [
          'cover_url',
          'content_thumb',
          'cover_url_v2',
          'big_pic_url',
          'avatar',
          'url_list'
        ]),
        url: shareUrl,
        author: asString(content.comment_user_name) || asString(content.nickname),
        itemId: itemId || undefined,
        kind: CARD_KIND[rawType]
      }
    }

    default:
      return {
        text:
          asString(content.tips) ||
          asString(content.text) ||
          asString(content.description) ||
          asString(content.hello_text) ||
          ''
      }
  }
}

const toText = (sub?: Buffer): string => (sub ? sub.toString('utf8') : '')

function jsonContent(sub?: Buffer): Record<string, unknown> | null {
  if (!sub || sub[0] !== 0x7b) return null
  try {
    return JSON.parse(sub.toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function pick(fields: Field[], fn: number): Field | undefined {
  return fields.find((f) => f.fn === fn)
}

/**
 * 从已解析字段构造会话。
 * 会话节点特征：fn1 会话ID / fn3 类型(1私信 2群) / fn6 参与者 / fn50 详情
 */
export function decodeConversationFields(outer: Field[], selfId: string): ImConversation {
  const detailField = pick(outer, 50)
  const detail = detailField ? parseFields(detailField.sub!) : []
  const participantsField = outer.filter((f) => f.fn === 6)

  const participants: ImParticipant[] = []
  for (const pf of participantsField) {
    try {
      const entries = parseFields(pf.sub!)
      // 群聊：每个 field6 就是一位成员；私信：field6 里嵌套多条
      const members = entries.some((e) => e.fn === 1 && e.sub && e.sub.length > 2)
        ? entries.filter((e) => e.fn === 1 && e.sub).map((e) => parseFields(e.sub!))
        : [entries]
      for (const m of members) {
        const id = pick(m, 1)
        participants.push({
          id: id ? (id.vs ?? String(id.v ?? '')) : '',
          name: toText(pick(m, 4)?.sub),
          // 注意：#5 是 sec_uid（MS4wLjAB 开头），不是头像地址
          secUid: toText(pick(m, 5)?.sub),
          avatar: toText(pick(m, 7)?.sub)
        })
      }
    } catch {
      /* 跳过异常成员 */
    }
  }

  const peer = participants.find((p) => p.id !== selfId) ?? participants[0]
  const title = toText(pick(detail, 5)?.sub) || peer?.name || ''
  const avatarUrl = toText(pick(detail, 7)?.sub) || peer?.avatar || ''
  const type = pick(outer, 3)?.v === 2 ? 'group' : 'private'
  const convIdField = pick(detail, 1)
  const convId = toText(convIdField?.sub) || (pick(outer, 1)?.sub ? toText(pick(outer, 1)!.sub) : '')

  return {
    id: convId,
    type,
    title,
    preview: toText(pick(detail, 6)?.sub),
    avatarUrl,
    peerId: type === 'private' ? (peer?.id ?? '') : '',
    peerSecUid: toText(pick(detail, 13)?.sub) || peer?.secUid || '',
    lastMessageAt: (pick(detail, 4)?.v ?? 0) * 1000,
    memberCount: participants.length,
    participants
  }
}

/**
 * 从已解析字段构造消息。
 * 消息节点特征：fn1 会话ID / fn3 消息ID / fn6 类型 / fn7 发送者 / fn8 JSON 内容 / fn9 扩展 map
 */
export function decodeMessageFields(f: Field[], selfId: string, nameOf: Map<string, string>): Message | null {
  const id = pick(f, 3)
  const convId = toText(pick(f, 1)?.sub)
  if (!id || !convId) return null

  const extras: Record<string, string> = {}
  for (const e of f.filter((x) => x.fn === 9)) {
    try {
      const kv = parseFields(e.sub!)
      const k = toText(kv[0]?.sub)
      const v = kv[1] ? (kv[1].sub ? toText(kv[1].sub) : (kv[1].vs ?? String(kv[1].v ?? ''))) : ''
      if (k) extras[k] = v
    } catch {
      /* ignore */
    }
  }

  const contentField = pick(f, 8)
  const content = jsonContent(contentField?.sub)
  const rawType = pick(f, 6)?.v ?? 0
  const type = IM_TYPE[rawType] ?? 'system'
  const senderId = pick(f, 7)?.vs ?? String(pick(f, 7)?.v ?? '')
  const createdAt =
    Number(content?.createdAt ?? 0) ||
    Number(extras['s:server_message_create_time'] ?? 0) ||
    Math.round(Number(pick(f, 4)?.v ?? 0) / 1000)

  const body = buildContent(rawType, type, content)

  return {
    id: id.vs ?? String(id.v ?? ''),
    clientId: id.vs ?? String(id.v ?? ''),
    conversationId: convId,
    accountId: '',
    senderId,
    senderName: nameOf.get(senderId) ?? (senderId === selfId ? '我' : senderId),
    senderSecUid: toText(pick(f, 14)?.sub) || undefined,
    type,
    content: body,
    createdAt: createdAt || Date.now(),
    status: 'sent',
    isSelf: Boolean(selfId) && senderId === selfId
  }
}

/** 解码 /v1/message/get_message_by_init 的响应 payload */
export function decodeImResponse(buf: Buffer, selfId: string): ImDecoded {
  let root: Field[]
  try {
    root = parseFields(buf)
  } catch {
    return { conversations: [], messages: [] }
  }
  const ext = pick(root, 6)
  if (!ext?.sub) return { conversations: [], messages: [] }
  const extFields = parseFields(ext.sub)
  const payloadField = extFields.find((f) => f.sub)
  if (!payloadField?.sub) return { conversations: [], messages: [] }

  const payload = parseFields(payloadField.sub)
  const conversations: ImConversation[] = []
  const rawMessages: Array<{ field: Field; convId: string }> = []

  for (const item of payload) {
    if (item.fn !== 1 || !item.sub) continue
    let fields: Field[]
    try {
      fields = parseFields(item.sub)
    } catch {
      continue
    }
    const convField = pick(fields, 1)
    if (convField?.sub) {
      try {
        conversations.push(decodeConversationFields(parseFields(convField.sub), selfId))
      } catch {
        /* skip */
      }
    }
    for (const m of fields.filter((x) => x.fn === 2)) rawMessages.push({ field: m, convId: '' })
  }

  const nameOf = new Map<string, string>()
  for (const c of conversations) for (const p of c.participants) if (p.name) nameOf.set(p.id, p.name)

  const messages: Message[] = []
  for (const { field } of rawMessages) {
    if (!field.sub) continue
    let parsed: Field[]
    try {
      parsed = parseFields(field.sub)
    } catch {
      continue
    }
    const m = decodeMessageFields(parsed, selfId, nameOf)
    if (m) messages.push(m)
  }
  return { conversations, messages }
}
