import { describe, expect, it } from 'vitest'
import {
  buildConversationId,
  decodeContent,
  encodeContent,
  normalizeConversation,
  normalizeMessage,
  parseConversationId,
  previewOfType,
  toMs,
  WIRE_MSG_TYPE,
  type RawConversation,
  type RawMessage
} from '../../src/main/adapters/wire'

describe('wire · 时间与 ID', () => {
  it('秒级时间戳转毫秒', () => {
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000)
  })

  it('已是毫秒的时间戳不重复放大', () => {
    expect(toMs(1_700_000_000_123)).toBe(1_700_000_000_123)
  })

  it('空值与非法值归零', () => {
    expect(toMs(undefined)).toBe(0)
    expect(toMs(null)).toBe(0)
    expect(toMs(0)).toBe(0)
    expect(toMs('abc')).toBe(0)
  })

  it('解析私信 / 群聊会话 ID', () => {
    expect(parseConversationId('0:1:peer_1:self_1')).toEqual({ type: 'private', peerId: 'peer_1' })
    expect(parseConversationId('0:2:group_9:self_1')).toEqual({ type: 'group', peerId: 'group_9' })
  })

  it('构造会话 ID 与解析互逆', () => {
    const id = buildConversationId('private', 'peer_2', 'self_1')
    expect(id).toBe('0:1:peer_2:self_1')
    expect(parseConversationId(id).peerId).toBe('peer_2')
  })
})

describe('wire · 消息载荷编解码', () => {
  it('纯文本内容直接透传', () => {
    expect(decodeContent(WIRE_MSG_TYPE.TEXT, '今天吃什么')).toEqual({ text: '今天吃什么' })
  })

  it('JSON 包裹的文本也能解出', () => {
    expect(decodeContent(WIRE_MSG_TYPE.TEXT, '{"text":"嵌套文本"}')).toEqual({ text: '嵌套文本' })
  })

  it('图片消息解析 url 与尺寸', () => {
    const raw = JSON.stringify({ url: 'https://x/a.jpg', width: 1080, height: 1440, thumb_url: 'https://x/t.jpg' })
    expect(decodeContent(WIRE_MSG_TYPE.IMAGE, raw)).toMatchObject({
      url: 'https://x/a.jpg',
      width: 1080,
      height: 1440,
      thumbUrl: 'https://x/t.jpg'
    })
  })

  it('文件消息缺字段时给出兜底名称', () => {
    const c = decodeContent(WIRE_MSG_TYPE.FILE, JSON.stringify({ url: 'https://x/f.zip', size: 2048 }))
    expect(c.name).toBe('未命名文件')
    expect(c.size).toBe(2048)
  })

  it('损坏的 JSON 不抛异常，降级为原文', () => {
    expect(decodeContent(WIRE_MSG_TYPE.IMAGE, '{broken').url).toBe('{broken')
  })

  it('encode → decode 保持语义', () => {
    const encoded = encodeContent('image', { url: 'https://x/b.png', width: 10, height: 20 })
    expect(decodeContent(WIRE_MSG_TYPE.IMAGE, encoded)).toMatchObject({ url: 'https://x/b.png', width: 10, height: 20 })
  })
})

describe('wire · 模型归一化', () => {
  const rawMessage: RawMessage = {
    msg_id: 'm1',
    conversation_id: '0:1:p1:me',
    sender: 'p1',
    sender_nickname: '阿泽',
    msg_type: WIRE_MSG_TYPE.TEXT,
    content: '在吗',
    create_time: 1_700_000_000,
    status: 3
  }

  it('归一化出毫秒时间、已读状态与非本人标记', () => {
    const msg = normalizeMessage(rawMessage, 'acc_1', 'me')
    expect(msg.createdAt).toBe(1_700_000_000_000)
    expect(msg.status).toBe('read')
    expect(msg.isSelf).toBe(false)
    expect(msg.clientId).toBe('m1')
  })

  it('本人发送时 isSelf 为 true', () => {
    const msg = normalizeMessage({ ...rawMessage, sender: 'me' }, 'acc_1', 'me')
    expect(msg.isSelf).toBe(true)
  })

  it('撤回消息统一为 recalled 且内容清空', () => {
    const msg = normalizeMessage({ ...rawMessage, is_recalled: 1 }, 'acc_1', 'me')
    expect(msg.status).toBe('recalled')
    expect(msg.content.text).toBe('')
    expect(msg.recalledAt).toBe(1_700_000_000_000)
  })

  it('会话归一化：标题、预览、置顶与免打扰', () => {
    const raw: RawConversation = {
      conversation_id: '0:1:p1:me',
      conversation_type: 1,
      name: '阿泽',
      avatar: 'https://x/a.png',
      peer_uid: 'p1',
      unread_count: 3,
      update_time: 1_700_000_100,
      is_pinned: 1,
      is_muted: 1,
      last_message: rawMessage
    }
    const conv = normalizeConversation(raw, 'acc_1', 'me')
    expect(conv.title).toBe('阿泽')
    expect(conv.peerId).toBe('p1')
    expect(conv.unreadCount).toBe(3)
    expect(conv.pinned).toBe(true)
    expect(conv.muted).toBe(true)
    expect(conv.lastMessagePreview).toBe('在吗')
    expect(conv.lastMessageAt).toBe(1_700_000_100_000)
  })

  it('列表预览按消息类型生成占位文案', () => {
    expect(previewOfType('image', '{}')).toBe('[图片]')
    expect(previewOfType('voice', JSON.stringify({ url: 'u', duration: 12 }))).toBe('[语音] 12"')
    expect(previewOfType('file', JSON.stringify({ name: '报告.pdf' }))).toBe('[文件] 报告.pdf')
  })
})
