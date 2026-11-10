#!/usr/bin/env node
/**
 * 抖音 IM protobuf 快照解码器
 *
 * 输入：浏览器导出的 HAR（含 imapi.douyin.com 的 /v1/message/get_message_by_init 响应）
 * 输出：会话/消息的结构化统计（默认不含任何正文），以及可选的快照 JSON
 *
 * 用法：
 *   node scripts/im-decode.mjs --har ~/Downloads/douyin.har
 *   node scripts/im-decode.mjs --har douyin.har --json > snapshot.json
 */
import { readFileSync } from 'node:fs'

function varint(buf, i) {
  let v = 0
  let shift = 0
  while (i < buf.length) {
    const b = buf[i++]
    v += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) return [v, i]
    shift += 7
    if (shift > 63) throw new Error('varint 溢出')
  }
  throw new Error('varint 截断')
}

/** 通用 protobuf 解析：返回 [{fn, wt, v?, sub?}]，不解释语义 */
export function parseFields(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    let key
    ;[key, i] = varint(buf, i)
    const fn = key >> 3
    const wt = key & 7
    if (!fn) throw new Error('字段号为 0')
    if (wt === 0) {
      let v
      ;[v, i] = varint(buf, i)
      out.push({ fn, wt, v })
    } else if (wt === 2) {
      let len
      ;[len, i] = varint(buf, i)
      if (i + len > buf.length) throw new Error('长度越界')
      out.push({ fn, wt, sub: buf.subarray(i, i + len) })
      i += len
    } else if (wt === 5) {
      if (i + 4 > buf.length) throw new Error('越界')
      out.push({ fn, wt, v: buf.readUInt32LE(i) })
      i += 4
    } else if (wt === 1) {
      if (i + 8 > buf.length) throw new Error('越界')
      out.push({ fn, wt, v: buf.readBigUInt64LE(i) })
      i += 8
    } else {
      throw new Error(`不支持的 wire type ${wt}`)
    }
  }
  return out
}

const text = (sub) => {
  try {
    return sub.toString('utf8')
  } catch {
    return ''
  }
}

/** JSON 内容（type=7 等）解析，失败返回 null */
function parseJsonContent(sub) {
  if (!sub || sub[0] !== 0x7b) return null
  try {
    return JSON.parse(text(sub))
  } catch {
    return null
  }
}

/** 会话：外层字段 + #50 详情 */
function decodeConversation(bundle, selfId = '') {
  const outer = parseFields(bundle)
  const detailField = outer.find((f) => f.fn === 50)
  const detail = detailField ? parseFields(detailField.sub) : []
  const pick = (fields, fn) => fields.find((f) => f.fn === fn)

  const id = pick(outer, 1) ? text(pick(outer, 1).sub) : ''
  const type = pick(outer, 3)?.v ?? 0
  const participants = outer.filter((f) => f.fn === 6).map((f) => {
    const p = parseFields(f.sub)
    return {
      id: pick(p, 1) ? String(pick(p, 1).v) : '',
      name: pick(p, 4) ? text(pick(p, 4).sub) : '',
      avatar: pick(p, 5) ? text(pick(p, 5).sub) : ''
    }
  })

  // 私信会话的标题/头像不在详情里，取「对方」的资料
  const peer = participants.find((p) => p.id !== selfId) ?? participants[0]
  const rawTitle = pick(detail, 5) ? text(pick(detail, 5).sub) : ''
  const rawAvatar = pick(detail, 7) ? text(pick(detail, 7).sub) : ''

  return {
    id,
    shortId: pick(outer, 2) ? String(pick(outer, 2).v) : id,
    type: type === 2 ? 'group' : 'private',
    title: rawTitle || peer?.name || '',
    preview: pick(detail, 6) ? text(pick(detail, 6).sub) : '',
    avatarUrl: rawAvatar || peer?.avatar || '',
    peerId: type === 2 ? '' : (peer?.id ?? ''),
    lastMessageAt: (pick(detail, 4)?.v ?? 0) * 1000,
    memberCount: participants.length,
    participants
  }
}

const IM_TYPE = {
  1: 'system',
  7: 'text',
  8: 'share',
  27: 'image',
  77: 'share',
  105: 'share'
}

/** 消息：外层 #1 conversationId, #3 id, #6 type, #7 sender, #8 content, #9 extras */
function decodeMessage(field, selfId) {
  const f = parseFields(field.sub)
  const pick = (fn) => f.find((x) => x.fn === fn)
  const extra = Object.fromEntries(
    f
      .filter((x) => x.fn === 9)
      .map((x) => {
        const kv = parseFields(x.sub)
        const k = kv[0] ? text(kv[0].sub) : ''
        const v = kv[1] ? (kv[1].sub ? text(kv[1].sub) : String(kv[1].v)) : ''
        return [k, v]
      })
      .filter(([k]) => k)
  )
  const contentField = pick(8)
  const content = contentField ? parseJsonContent(contentField.sub) : null
  const senderId = pick(7) ? String(pick(7).v) : ''
  const tsMs = Number(content?.createdAt ?? 0) || Number(extra['s:server_message_create_time'] ?? 0) || 0
  const msgType = IM_TYPE[pick(6)?.v] ?? 'text'

  let body = { text: '' }
  if (msgType === 'text') body = { text: content?.text ?? '' }
  else if (msgType === 'image') body = { url: content?.url_list?.[0] ?? content?.origin_url ?? '', width: content?.width, height: content?.height }
  else if (msgType === 'share') body = { title: content?.content_title ?? content?.title ?? '', desc: content?.content_name ?? '', url: content?.share_url ?? '' }

  return {
    id: pick(3) ? String(pick(3).v) : '',
    conversationId: pick(1) ? text(pick(1).sub) : '',
    type: msgType,
    rawType: pick(6)?.v ?? 0,
    senderId,
    isSelf: Boolean(selfId) && senderId === selfId,
    createdAt: tsMs || Math.round(Number(pick(4)?.v ?? 0) / 1000),
    content: body
  }
}

export function decodeInitResponse(buf, selfId = '') {
  const root = parseFields(buf)
  const ext = root.find((f) => f.fn === 6)
  if (!ext) throw new Error('未找到扩展字段 #6')
  const payload = parseFields(parseFields(ext.sub)[0].sub)
  const conversations = []
  const messages = []
  for (const item of payload) {
    if (item.fn !== 1 || !item.sub) continue
    const fields = parseFields(item.sub)
    const convField = fields.find((f) => f.fn === 1)
    if (convField) conversations.push(decodeConversation(convField.sub, selfId))
    for (const m of fields.filter((f) => f.fn === 2)) {
      const msg = decodeMessage(m, selfId)
      if (msg.id) messages.push(msg)
    }
  }
  return { conversations, messages }
}

function main() {
  const args = process.argv.slice(2)
  const harPath = args[args.indexOf('--har') + 1]
  if (!harPath || harPath.startsWith('--')) {
    console.error('用法：node scripts/im-decode.mjs --har <file.har> [--json]')
    process.exit(2)
  }
  const har = JSON.parse(readFileSync(harPath.replace(/^~(?=$|\/)/, process.env.HOME ?? ''), 'utf8'))
  const entries = (har.log?.entries ?? []).filter(
    (e) => e.request?.url?.includes('imapi.douyin.com') && e.response?.content?.text
  )

  // 当前登录用户（从 www.douyin.com 的 self 接口拿）
  let selfId = ''
  const selfEntry = (har.log?.entries ?? []).find(
    (e) => e.request?.url?.includes('/user/profile/self') && e.response?.content?.text
  )
  if (selfEntry) {
    try {
      const j = JSON.parse(selfEntry.response.content.text)
      selfId = String(j.user?.uid ?? '')
    } catch {
      /* ignore */
    }
  }

  const initEntries = entries.filter((e) => e.request.url.includes('/v1/message/get_message_by_init'))
  if (!initEntries.length) {
    console.error('HAR 中没有 /v1/message/get_message_by_init 响应，请先打开私信页面再导出')
    process.exit(1)
  }

  let merged = { conversations: [], messages: [] }
  for (const e of initEntries) {
    const buf = Buffer.from(e.response.content.text, 'base64')
    try {
      const decoded = decodeInitResponse(buf, selfId)
      merged.conversations.push(...decoded.conversations)
      merged.messages.push(...decoded.messages)
    } catch (err) {
      console.error('解码失败：', err.message)
    }
  }

  // 去重
  const convMap = new Map(merged.conversations.map((c) => [c.id, c]))
  const msgMap = new Map(merged.messages.map((m) => [m.id, m]))
  const conversations = [...convMap.values()].map((c) => {
    const list = [...msgMap.values()].filter((m) => m.conversationId === c.id)
    const last = list.sort((a, b) => b.createdAt - a.createdAt)[0]
    return { ...c, messageCount: list.length, lastMessageAt: c.lastMessageAt || last?.createdAt || 0, preview: c.preview || (last ? (last.type === 'text' ? last.content.text?.slice(0, 40) : `[${last.type}]`) : '') }
  })
  const messages = [...msgMap.values()]

  const types = conversations.reduce((acc, c) => ({ ...acc, [c.type]: (acc[c.type] ?? 0) + 1 }), {})
  const msgTypes = messages.reduce((acc, m) => ({ ...acc, [m.rawType]: (acc[m.rawType] ?? 0) + 1 }), {})
  const times = messages.map((m) => m.createdAt).filter((t) => t > 1e12)
  const resolved = messages.filter((m) => m.senderId).length

  console.log(`\n抖音 IM 快照解析`)
  console.log('='.repeat(52))
  console.log(`HAR 中 imapi 响应      ${entries.length} 条`)
  console.log(`init 响应              ${initEntries.length} 条`)
  console.log(`self uid               ${selfId ? selfId.slice(0, 4) + '****' + selfId.slice(-4) : '未识别'}`)
  console.log(`会话                   ${conversations.length}（${Object.entries(types).map(([k, v]) => k + ' ' + v).join(' / ')}）`)
  console.log(`会话标题解析成功       ${conversations.filter((c) => c.title).length}/${conversations.length}`)
  console.log(`消息                   ${messages.length}`)
  console.log(`消息类型分布           ${Object.entries(msgTypes).map(([k, v]) => k + ' × ' + v).join('  ')}`)
  console.log(`发送者解析成功         ${resolved}/${messages.length}`)
  if (times.length) {
    console.log(`时间范围               ${new Date(Math.min(...times)).toISOString().slice(0, 16)} → ${new Date(Math.max(...times)).toISOString().slice(0, 16)}`)
  }
  const withAvatar = conversations.filter((c) => c.avatarUrl).length
  console.log(`会话头像解析成功       ${withAvatar}/${conversations.length}`)
  console.log()

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ selfId, conversations, messages }, null, 2))
  }
}

if (process.argv[1]?.endsWith('im-decode.mjs')) main()
