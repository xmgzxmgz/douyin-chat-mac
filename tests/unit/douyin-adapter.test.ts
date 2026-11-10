import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../../src/main/adapters/douyin/http-client'
import { DouyinWebAdapter } from '../../src/main/adapters/douyin/douyin-adapter'

const SELF = {
  uid: 'u_self',
  nickname: '林一',
  unique_id: 'linyi_0912',
  signature: '记录生活',
  avatar_thumb: { url_list: ['https://cdn/self.png'] }
}

const CONV_1 = {
  conversation_id: '0:1:u_peer:u_self',
  conversation_type: 1,
  name: '阿泽',
  avatar: 'https://cdn/peer.png',
  peer_uid: 'u_peer',
  unread_count: 2,
  update_time: 1_700_000_300,
  is_pinned: 1,
  last_message: {
    msg_id: 'm_last',
    conversation_id: '0:1:u_peer:u_self',
    sender: 'u_peer',
    sender_nickname: '阿泽',
    msg_type: 7,
    content: '晚上八点老地方？',
    create_time: 1_700_000_300,
    status: 2
  }
}

const CONV_2 = {
  conversation_id: '0:2:g_1:u_self',
  conversation_type: 2,
  name: '摄影交流群',
  peer_uid: 'g_1',
  member_count: 128,
  unread_count: 0,
  update_time: 1_700_000_100,
  last_message: {
    msg_id: 'm_g',
    conversation_id: '0:2:g_1:u_self',
    sender: 'u_x',
    sender_nickname: '小满',
    msg_type: 27,
    content: JSON.stringify({ url: 'https://cdn/p.jpg', width: 800, height: 600 }),
    create_time: 1_700_000_100,
    status: 1
  }
}

const HISTORY = [
  {
    msg_id: 'm2',
    conversation_id: '0:1:u_peer:u_self',
    sender: 'u_peer',
    sender_nickname: '阿泽',
    msg_type: 7,
    content: '在吗',
    create_time: 1_700_000_200,
    status: 2
  },
  {
    msg_id: 'm1',
    conversation_id: '0:1:u_peer:u_self',
    sender: 'u_self',
    sender_nickname: '林一',
    msg_type: 7,
    content: '在的',
    create_time: 1_700_000_100,
    status: 3
  }
]

interface Captured {
  url: string
  body?: string
  headers: Record<string, string>
}

function makeBackend(): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ url, body: init.body as string | undefined, headers })
    const json = (data: unknown): { ok: boolean; status: number; text: () => Promise<string> } => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(data)
    })

    if (url.includes('/im/user/info/')) return json({ status_code: 0, data: { user: SELF } })
    if (url.includes('/im/conversation/list/'))
      return json({ status_code: 0, data: { conversations: [CONV_1, CONV_2] } })
    if (url.includes('/im/message/history/')) return json({ status_code: 0, data: { messages: HISTORY } })
    if (url.includes('/im/message/send/'))
      return json({
        status_code: 0,
        data: {
          message: {
            msg_id: 'm_new',
            conversation_id: '0:1:u_peer:u_self',
            sender: 'u_self',
            sender_nickname: '林一',
            msg_type: 7,
            content: '你好呀',
            create_time: 1_700_000_400,
            status: 1
          }
        }
      })
    if (url.includes('/im/message/recall/')) return json({ status_code: 0, data: {} })
    if (url.includes('/im/friend/list/'))
      return json({ status_code: 0, data: { friends: [SELF, { uid: 'u_peer', nickname: '阿泽' }] } })
    return json({ status_code: 0, data: {} })
  }
  return { fetchImpl, calls }
}

function makeAdapter(): { adapter: DouyinWebAdapter; calls: Captured[] } {
  const { fetchImpl, calls } = makeBackend()
  const adapter = new DouyinWebAdapter({
    fetchImpl,
    minIntervalMs: 0,
    sleep: async () => {},
    maxRetries: 0,
    signer: { name: 'test', sign: async () => ({ a_bogus: 'test_sig' }) }
  })
  return { adapter, calls }
}

describe('DouyinWebAdapter · 鉴权', () => {
  it('缺少 sessionid 的 Cookie 直接被拒绝，不发请求', async () => {
    const { adapter, calls } = makeAdapter()
    await expect(adapter.loginWithCookie({ cookie: 'ttwid=only' })).rejects.toMatchObject({ code: 'AUTH_INVALID' })
    expect(calls).toHaveLength(0)
  })

  it('导入有效 Cookie 后拉取自身资料并生成账号', async () => {
    const { adapter } = makeAdapter()
    const result = await adapter.loginWithCookie({ cookie: 'sessionid=abc; ttwid=t1' })
    expect(result.account.nickname).toBe('林一')
    expect(result.account.accountId).toBe('acc_u_self_web')
    expect(result.account.mode).toBe('douyin-web')
    expect(result.credentials.cookie).toContain('sessionid=abc')
  })

  it('真实模式不提供扫码登录（未做 passport 逆向）', async () => {
    const { adapter } = makeAdapter()
    await expect(adapter.createQrLogin()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('DouyinWebAdapter · 数据归一化', () => {
  it('会话列表转换为领域模型，群聊与私信区分正确', async () => {
    const { adapter } = makeAdapter()
    await adapter.loginWithCookie({ cookie: 'sessionid=abc' })
    const list = await adapter.fetchConversations()
    expect(list).toHaveLength(2)
    const priv = list.find((c) => c.id === '0:1:u_peer:u_self')!
    expect(priv.type).toBe('private')
    expect(priv.title).toBe('阿泽')
    expect(priv.unreadCount).toBe(2)
    expect(priv.pinned).toBe(true)
    expect(priv.lastMessagePreview).toBe('晚上八点老地方？')
    const group = list.find((c) => c.id === '0:2:g_1:u_self')!
    expect(group.type).toBe('group')
    expect(group.memberCount).toBe(128)
    expect(group.lastMessagePreview).toBe('[图片]')
  })

  it('历史消息按时间倒序返回，时间戳为毫秒', async () => {
    const { adapter } = makeAdapter()
    await adapter.loginWithCookie({ cookie: 'sessionid=abc' })
    const history = await adapter.fetchHistory('0:1:u_peer:u_self', undefined, 20)
    expect(history.map((m) => m.id)).toEqual(['m2', 'm1'])
    expect(history[0].createdAt).toBe(1_700_000_200_000)
    expect(history[1].isSelf).toBe(true)
    expect(history[1].status).toBe('read')
  })

  it('拉取增量时按游标过滤旧消息', async () => {
    const { adapter } = makeAdapter()
    await adapter.loginWithCookie({ cookie: 'sessionid=abc' })
    const result = await adapter.pullUpdates(1_700_000_150_000)
    expect(result.messages.map((m) => m.id)).toEqual(['m2'])
    expect(result.cursor).toBe(1_700_000_200_000)
    expect(result.conversations).toHaveLength(2)
  })
})

describe('DouyinWebAdapter · 发送与撤回', () => {
  it('文本消息以 msg_type=7 与转义后的内容提交', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.loginWithCookie({ cookie: 'sessionid=abc' })
    const msg = await adapter.sendMessage({
      conversationId: '0:1:u_peer:u_self',
      type: 'text',
      content: { text: '你好呀' },
      clientId: 'c_1',
      localId: 'c_1'
    })
    expect(msg.id).toBe('m_new')
    expect(msg.clientId).toBe('c_1')
    expect(msg.isSelf).toBe(true)
    const sendCall = calls.find((c) => c.url.includes('/im/message/send/'))!
    const params = new URLSearchParams(sendCall.body)
    expect(params.get('msg_type')).toBe('7')
    expect(params.get('content')).toBe('你好呀')
    expect(params.get('client_id')).toBe('c_1')
    expect(params.get('conversation_id')).toBe('0:1:u_peer:u_self')
  })

  it('服务端不回消息体时回退为本地回执，保证 UI 一致', async () => {
    const fetchImpl: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes('/im/user/info/')
          ? JSON.stringify({ status_code: 0, data: { user: SELF } })
          : JSON.stringify({ status_code: 0, data: {} })
    })
    const adapter = new DouyinWebAdapter({
      fetchImpl,
      minIntervalMs: 0,
      sleep: async () => {},
      maxRetries: 0,
      signer: { name: 'test', sign: async () => ({}) }
    })
    await adapter.loginWithCookie({ cookie: 'sessionid=abc' })
    const msg = await adapter.sendMessage({
      conversationId: '0:1:u_peer:u_self',
      type: 'text',
      content: { text: 'hi' },
      clientId: 'c_2',
      localId: 'c_2'
    })
    expect(msg.id).toBe('c_2')
    expect(msg.status).toBe('sent')
    expect(msg.senderName).toBe('林一')
  })

  it('撤回请求携带 msg_id', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.loginWithCookie({ cookie: 'sessionid=abc' })
    await adapter.recallMessage('m_new')
    const call = calls.find((c) => c.url.includes('/im/message/recall/'))!
    expect(new URLSearchParams(call.body).get('msg_id')).toBe('m_new')
  })

  it('未接入的拉黑能力显式报 UNSUPPORTED', async () => {
    const { adapter } = makeAdapter()
    await adapter.loginWithCookie({ cookie: 'sessionid=abc' })
    await expect(adapter.setBlocked()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})
