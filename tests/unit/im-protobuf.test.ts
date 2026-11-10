import { describe, expect, it } from 'vitest'
import { DouyinImAdapter } from '../../src/main/adapters/douyin/im-adapter'
import {
  buildContent,
  decodeImResponse,
  encodeImRequest,
  parseFields,
  readEnvelope
} from '../../src/main/adapters/douyin/im-protobuf'

// ---- 构造 protobuf 的小工具（仅测试用） ----
function vint(n: number): Buffer {
  const out: number[] = []
  let v = n
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return Buffer.from(out)
}
const fv = (fn: number, v: number): Buffer => Buffer.concat([vint((fn << 3) | 0), vint(v)])
const fb = (fn: number, payload: Buffer): Buffer => Buffer.concat([vint((fn << 3) | 2), vint(payload.length), payload])
const fs = (fn: number, s: string): Buffer => fb(fn, Buffer.from(s, 'utf8'))

const CONV_ID = 'conv_1'
const SELF = '111'
const PEER = '222'

function buildConversation(): Buffer {
  const participant = Buffer.concat([fv(1, Number(PEER)), fs(4, '阿泽'), fs(5, 'https://cdn/peer.png')])
  const detail = Buffer.concat([
    fs(1, CONV_ID),
    fv(4, 1_700_000_000),
    fs(5, '产品群'),
    fs(6, '晚上见'),
    fs(7, 'https://cdn/group.png')
  ])
  return Buffer.concat([fs(1, CONV_ID), fv(3, 2), fb(6, participant), fb(50, detail)])
}

function buildMessage(text: string, sender = PEER, createdAt = 1_700_000_123_000): Buffer {
  return Buffer.concat([
    fs(1, CONV_ID),
    fv(3, 999),
    fv(6, 7),
    fv(7, Number(sender)),
    fs(8, JSON.stringify({ text, createdAt })),
    fb(9, Buffer.concat([fs(1, 's:server_message_create_time'), fs(2, String(createdAt))]))
  ])
}

function buildInitResponse(opts: { status?: number; message?: string; withData?: boolean } = {}): Buffer {
  const head = Buffer.concat([fv(1, 2043), fv(2, 10001), fv(3, opts.status ?? 0), fs(4, opts.message ?? 'OK')])
  if (opts.withData === false) return head
  const bundle = Buffer.concat([fb(1, buildConversation()), fb(2, buildMessage('在吗')), fb(2, buildMessage('在的', SELF, 1_700_000_124_000))])
  const payload = fb(1, bundle)
  const ext = fb(2043, payload)
  return Buffer.concat([head, fb(6, ext)])
}

const asResponse = (buf: Buffer, status = 200): Response =>
  ({
    status,
    arrayBuffer: async () => buf,
    text: async () => buf.toString('utf8')
  }) as unknown as Response

describe('IM protobuf · 编码', () => {
  it('最小信封与抓包前缀逐字节一致', () => {
    const buf = encodeImRequest({ userAgent: 'UA' }, false)
    expect(buf.toString('hex')).toBe('08d10f10a44e1a05302e312e382200')
    expect(buf.length).toBe(15)
  })

  it('完整信封包含元信息 map（session_aid / user_agent）', () => {
    const buf = encodeImRequest({ userAgent: 'UA/1.0' })
    const metas = parseFields(buf)
      .filter((f) => f.fn === 15)
      .map((f) => parseFields(f.sub!))
    const map = Object.fromEntries(metas.map((kv) => [kv[0].sub!.toString(), kv[1].sub!.toString()]))
    expect(map.session_aid).toBe('6383')
    expect(map.app_name).toBe('douyin_pc')
    expect(map.user_agent).toBe('UA/1.0')
    expect(map.referer).toBe('https://www.douyin.com/')
  })
})

describe('IM protobuf · 解码', () => {
  it('读取响应信封的状态码与文案', () => {
    const buf = buildInitResponse({ status: 1, message: 'unexepcted session length', withData: false })
    expect(readEnvelope(buf)).toMatchObject({
      cmd: 2043,
      status: 1,
      message: 'unexepcted session length'
    })
  })

  it('解析会话、消息、发送者与毫秒时间', () => {
    const { conversations, messages } = decodeImResponse(buildInitResponse(), SELF)
    expect(conversations).toHaveLength(1)
    expect(conversations[0]).toMatchObject({
      id: CONV_ID,
      type: 'group',
      title: '产品群',
      preview: '晚上见',
      avatarUrl: 'https://cdn/group.png',
      lastMessageAt: 1_700_000_000_000,
      memberCount: 1
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: '999', type: 'text', senderId: PEER, isSelf: false })
    expect(messages[0].content.text).toBe('在吗')
    expect(messages[0].createdAt).toBe(1_700_000_123_000)
    expect(messages[1].isSelf).toBe(true)
    expect(messages[1].senderName).toBe('我')
  })

  it('异常响应不抛错，返回空结果', () => {
    expect(decodeImResponse(Buffer.from('not-protobuf'), SELF)).toEqual({ conversations: [], messages: [] })
  })
})

describe('DouyinImAdapter · 鉴权', () => {
  it('缺少 sessionid 直接拒绝', async () => {
    const adapter = new DouyinImAdapter({ fetchImpl: async () => asResponse(Buffer.alloc(0)) })
    await expect(adapter.loginWithCookie({ cookie: 'ttwid=x' })).rejects.toMatchObject({ code: 'AUTH_INVALID' })
  })

  it('网关拒绝会话时给出可读错误', async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes('profile/self')) return asResponse(Buffer.from(JSON.stringify({ status_code: 8 })))
      return asResponse(buildInitResponse({ status: 1, message: 'unexepcted session length', withData: false }))
    }
    const adapter = new DouyinImAdapter({ fetchImpl, timeoutMs: 1000 })
    await expect(adapter.loginWithCookie({ cookie: 'sessionid=fake' })).rejects.toMatchObject({
      code: 'AUTH_EXPIRED'
    })
  })

  it('登录成功后返回账号资料与会话', async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes('profile/self')) {
        return asResponse(
          Buffer.from(
            JSON.stringify({
              status_code: 0,
              user: { uid: SELF, nickname: '林一', unique_id: 'linyi', avatar_thumb: { url_list: ['https://cdn/me.png'] } }
            })
          )
        )
      }
      return asResponse(buildInitResponse())
    }
    const adapter = new DouyinImAdapter({ fetchImpl, timeoutMs: 1000 })
    const res = await adapter.loginWithCookie({ cookie: 'sessionid=real' })
    expect(res.account).toMatchObject({ id: SELF, nickname: '林一', mode: 'douyin-web' })
    expect(res.account.accountId).toBe(`acc_${SELF}_im`)

    const convs = await adapter.fetchConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0]).toMatchObject({ title: '产品群', type: 'group', lastMessagePreview: '晚上见' })

    const pull = await adapter.pullUpdates(1_700_000_123_500)
    expect(pull.messages).toHaveLength(1)
    expect(pull.messages[0].content.text).toBe('在的')
    expect(pull.cursor).toBe(1_700_000_124_000)
  })
})

describe('DouyinImAdapter · 只读边界', () => {
  it('发送与撤回显式返回 UNSUPPORTED', async () => {
    const adapter = new DouyinImAdapter({ fetchImpl: async () => asResponse(buildInitResponse()) })
    await expect(adapter.sendMessage()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(adapter.recallMessage()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('IM protobuf · 富内容解析', () => {
  const url = (u: string) => ({ url_list: [u] })

  it('分享视频：取嵌套封面、去掉 [分享视频] 前缀、描述不重复', () => {
    const body = buildContent(8, 'share', {
      content_title: '[分享视频]晚自习下课后的放松时刻',
      content_name: '[分享视频]晚自习下课后的放松时刻',
      cover_url: url('https://cdn/cover.jpg'),
      itemId: '7300000000000000001'
    })
    expect(body.title).toBe('晚自习下课后的放松时刻')
    expect(body.desc).toBeUndefined()
    expect(body.coverUrl).toBe('https://cdn/cover.jpg')
    expect(body.url).toBe('https://www.douyin.com/video/7300000000000000001')
    expect(body.kind).toBe('视频')
  })

  it('评论分享：用 comment_url 作为跳转、保留评论内容', () => {
    const body = buildContent(105, 'share', {
      comment: '这条评论很有意思',
      cover_url: url('https://cdn/c.jpg'),
      comment_url: url('https://www.douyin.com/note/123')
    })
    expect(body.title).toBe('这条评论很有意思')
    expect(body.url).toBe('https://www.douyin.com/note/123')
  })

  it('表情消息：type=5 取图片地址与尺寸', () => {
    const body = buildContent(5, 'emoji', {
      url: url('https://cdn/emoji.png'),
      width: 120,
      height: 120,
      danmaku_text: '[微笑]'
    })
    expect(body.url).toBe('https://cdn/emoji.png')
    expect(body.emojiName).toBe('[微笑]')
    expect(body.width).toBe(120)
  })

  it('语音：毫秒转秒', () => {
    expect(buildContent(17, 'voice', { duration: 3400 }).duration).toBe(3)
    expect(buildContent(17, 'voice', { duration: 8 }).duration).toBe(8)
  })

  it('图片：兼容 data: 内联与 url_list', () => {
    expect(buildContent(27, 'image', { url_list: ['https://cdn/a.jpg'] }).url).toBe('https://cdn/a.jpg')
    expect(buildContent(27, 'image', { inline_pic: 'data:image/png;base64,AAA' }).url).toBe(
      'data:image/png;base64,AAA'
    )
  })
})
