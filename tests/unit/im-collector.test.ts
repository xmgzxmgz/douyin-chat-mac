import { describe, expect, it } from 'vitest'
import { ImCollector } from '../../src/main/adapters/douyin/im-collector'

// ---- protobuf 构造工具（与 im-protobuf.test.ts 同风格） ----
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

const CONV = 'conv_1'
const SELF = '111'
const PEER = '222'

function conversation(): Buffer {
  // 与真实抓包一致：参与者只有 uid 与头像，昵称要靠另一路 JSON 资料补全
  const participant = Buffer.concat([fv(1, Number(PEER)), fs(5, 'https://cdn/peer.png')])
  const detail = Buffer.concat([fs(1, CONV), fv(4, 1_700_000_000), fs(5, ''), fs(6, ''), fs(7, '')])
  return Buffer.concat([fs(1, CONV), fv(3, 1), fb(6, participant), fb(50, detail)])
}

function message(id: number, text: string, sender = PEER, createdAt = 1_700_000_120_000): Buffer {
  return Buffer.concat([
    fs(1, CONV),
    fv(3, id),
    fv(6, 7),
    fv(7, Number(sender)),
    fs(8, JSON.stringify({ text, createdAt }))
  ])
}

/** init 风格：payload 的每一项是「会话 + 若干消息」的 bundle */
function initResponse(): Buffer {
  const bundle = Buffer.concat([
    fb(1, conversation()),
    fb(2, message(901, '在吗')),
    fb(2, message(902, '在的', SELF, 1_700_000_124_000))
  ])
  const payload = fb(1, bundle)
  return Buffer.concat([Buffer.concat([fv(1, 2043), fv(3, 0), fs(4, 'OK')]), fb(6, fb(2043, payload))])
}

/** 增量风格：payload 的每一项直接就是一条消息（层级完全不同） */
function incrementalResponse(id: number, text: string, createdAt: number): Buffer {
  const payload = Buffer.concat([fb(1, message(id, text, PEER, createdAt))])
  return Buffer.concat([Buffer.concat([fv(1, 2050), fv(3, 0), fs(4, 'OK')]), fb(6, fb(2050, payload))])
}

describe('ImCollector · 容错解码', () => {
  it('从 init 响应中识别会话与消息', () => {
    const c = new ImCollector(() => SELF)
    const stats = c.ingest(initResponse())
    expect(stats.conversations).toBe(1)
    expect(stats.messages).toBe(2)
    const snap = c.snapshot()
    expect(snap.conversations[0].id).toBe(CONV)
    expect(snap.conversations[0].peerId).toBe(PEER)
    expect(snap.messages.map((m) => m.content.text)).toEqual(['在吗', '在的'])
  })

  it('不依赖端点层级：增量响应（消息直接在 payload 下）也能识别', () => {
    const c = new ImCollector(() => SELF)
    c.ingest(initResponse())
    const stats = c.ingest(incrementalResponse(903, '刚到家', 1_700_000_200_000))
    expect(stats.messages).toBe(1)
    expect(c.snapshot().messages.at(-1)?.content.text).toBe('刚到家')
  })

  it('重复投递同一条响应不会产生重复消息', () => {
    const c = new ImCollector(() => SELF)
    c.ingest(initResponse())
    const again = c.ingest(initResponse())
    expect(again).toEqual({ conversations: 0, messages: 0 })
    expect(c.snapshot().messages).toHaveLength(2)
  })

  it('自他判断在读取时解析，登录后补上 selfId 也能纠正', () => {
    const c = new ImCollector(() => '')
    c.ingest(initResponse())
    expect(c.snapshot().messages.every((m) => !m.isSelf)).toBe(true)
    const c2 = new ImCollector(() => SELF)
    c2.ingest(initResponse())
    expect(c2.snapshot().messages.find((m) => m.content.text === '在的')?.isSelf).toBe(true)
    expect(c2.snapshot().messages.find((m) => m.content.text === '在的')?.senderName).toBe('我')
  })

  it('会话预览按最新消息回填', () => {
    const c = new ImCollector(() => SELF)
    c.ingest(initResponse())
    const conv = c.snapshot().conversations[0]
    expect(conv.preview).toBe('在的')
    expect(conv.lastMessageAt).toBe(1_700_000_124_000)
  })

  it('since(cursor) 只返回新于游标的消息', () => {
    const c = new ImCollector(() => SELF)
    c.ingest(initResponse())
    expect(c.since(1_700_000_123_999)).toHaveLength(1)
    expect(c.since(1_700_000_124_000)).toHaveLength(0)
  })

  it('脏数据不抛错', () => {
    const c = new ImCollector(() => SELF)
    expect(() => c.ingest(Buffer.from([0x00, 0x01, 0x02]))).not.toThrow()
    expect(() => c.ingest(Buffer.alloc(0))).not.toThrow()
    expect(c.snapshot()).toEqual({ conversations: [], messages: [] })
  })

  it('统计只含数量，不含内容', () => {
    const c = new ImCollector(() => SELF)
    c.ingest(initResponse())
    const s = c.stats()
    expect(s).toMatchObject({ payloads: 1, conversations: 1, messages: 2 })
    expect(JSON.stringify(s)).not.toContain('在吗')
  })
})

describe('ImCollector · JSON 用户资料', () => {
  it('从任意层级的 JSON 中抽取 uid → 昵称，并回填到会话标题', () => {
    const c = new ImCollector(() => SELF)
    c.ingest(initResponse())
    // 昵称缺失时用 uid 后四位兜底，避免界面上全是「未命名会话」
    expect(c.snapshot().conversations[0].title).toBe('抖音用户222')

    const added = c.ingestJson({
      data: { conversations: [{ conversation_id: CONV, participants: [{ uid: PEER, nickname: '阿泽' }] }] }
    })
    expect(added).toBe(1)

    const conv = c.snapshot().conversations[0]
    expect(conv.title).toBe('阿泽')
    expect(c.snapshot().messages[0].senderName).toBe('阿泽')
  })

  it('忽略 URL 形式的名字，避免把头像当昵称', () => {
    const c = new ImCollector(() => SELF)
    c.ingestJson([{ uid: '123456', nickname: 'https://cdn/x.png' }])
    expect(c.stats().names).toBe(0)
  })

  it('uid 过短的对象不参与匹配（避免把普通 id 当用户）', () => {
    const c = new ImCollector(() => SELF)
    c.ingestJson([{ uid: '12', nickname: '某人' }])
    expect(c.stats().names).toBe(0)
  })
})
