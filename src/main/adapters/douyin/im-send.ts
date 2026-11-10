/**
 * 发送消息的 protobuf 编码。
 *
 * 结构来自一次真实抓包（/v1/message/send，content-type: application/x-protobuf）：
 *
 *   1  = 100                        // 命令号
 *   2  = 10018
 *   3  = "0.1.8"                    // 客户端版本
 *   5  = 3
 *   7  = "0d50935:feat/pc-im-group" // 分支标识
 *   8  = { 100: <message> }         // 业务体
 *   9  = "0"
 *   11 = "douyin_pc"
 *   14 = "360000"
 *   15 = { 1: "identity_security_token", 2: '{"token":"..."}' }
 *
 * <message>：
 *   1 = "0:1:<xxx>:<selfUid>"       // 会话 ID
 *   2 = 1
 *   3 = 消息 ID（19 位数字）
 *   4 = {"aweType":700,"type":0,"richTextInfos":[],"text":"..."}
 *   5 = 重复 KV：a:chat_bubble / s:mentioned_users / s:client_message_id / s:stime
 *   6 = 7                            // 消息类型（7 = 文本）
 *   7 = 会话 token（121 字节，即会话包里的 #4 字段）
 *   8 = client_message_id
 */

export interface SendBodyInput {
  conversationId: string
  text: string
  /** 会话级 121 字节 token（会话 #4） */
  conversationToken: string
  /** 页面上的 identity_security_token（/15 的第二个字段） */
  identityToken: string
  selfUid: string
}

function varint(value: number | bigint): Buffer {
  let v = typeof value === 'bigint' ? value : BigInt(value)
  const out: number[] = []
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return Buffer.from(out)
}

function tag(field: number, wire: number): Buffer {
  return varint((field << 3) | wire)
}

function fVarint(field: number, value: number | bigint): Buffer {
  return Buffer.concat([tag(field, 0), varint(value)])
}

function fBytes(field: number, value: Buffer | string): Buffer {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return Buffer.concat([tag(field, 2), varint(buf.length), buf])
}

/**
 * 设备/会话参数（从真实请求中原样保留）。
 * 里面是 identity_security_device_id、session_aid、session_did、UA、分辨率等，
 * 服务端校验 token 时要对得上，缺一个就会报 "empty token"。
 */
const DEVICE_PARAMS = Buffer.from('ejIKG2lkZW50aXR5X3NlY3VyaXR5X2RldmljZV9pZBITNzY2OTE0Mjg0NTg1MjIzOTQxNHoZChVpZGVudGl0eV9zZWN1cml0eV9haWQSAHoTCgtzZXNzaW9uX2FpZBIENjM4M3oQCgtzZXNzaW9uX2RpZBIBMHoVCghhcHBfbmFtZRIJZG91eWluX3BjehUKD3ByaW9yaXR5X3JlZ2lvbhICY256gwEKCnVzZXJfYWdlbnQSdU1vemlsbGEvNS4wIChNYWNpbnRvc2g7IEludGVsIE1hYyBPUyBYIDEwXzE1XzcpIEFwcGxlV2ViS2l0LzUzNy4zNiAoS0hUTUwsIGxpa2UgR2Vja28pIENocm9tZS8xNTYuMC4wLjAgU2FmYXJpLzUzNy4zNnoWCg5jb29raWVfZW5hYmxlZBIEdHJ1ZXoZChBicm93c2VyX2xhbmd1YWdlEgV6aC1DTnocChBicm93c2VyX3BsYXRmb3JtEghNYWNJbnRlbHoXCgxicm93c2VyX25hbWUSB01vemlsbGF6gAEKD2Jyb3dzZXJfdmVyc2lvbhJtNS4wIChNYWNpbnRvc2g7IEludGVsIE1hYyBPUyBYIDEwXzE1XzcpIEFwcGxlV2ViS2l0LzUzNy4zNiAoS0hUTUwsIGxpa2UgR2Vja28pIENocm9tZS8xNTYuMC4wLjAgU2FmYXJpLzUzNy4zNnoWCg5icm93c2VyX29ubGluZRIEdHJ1ZXoUCgxzY3JlZW5fd2lkdGgSBDE5MjB6FQoNc2NyZWVuX2hlaWdodBIEMTA4MHoiCgdyZWZlcmVyEhdodHRwczovL3d3dy5kb3V5aW4uY29tL3oeCg10aW1lem9uZV9uYW1lEg1Bc2lhL1NoYW5naGFpeg0KCGRldmljZUlkEgEweg0KCGlzLXJldHJ5EgEwkAEBqgEKZG91eWluX3dlYrIBB3dlYl9zZGs=', 'base64')

let seq = 0

/** 19 位消息 ID：时间戳左移 + 自增，保证本机唯一 */
function nextMessageId(): bigint {
  const ts = BigInt(Date.now())
  seq = (seq + 1) % 1000
  return (ts << 22n) + BigInt(seq)
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export interface BuiltSend {
  body: Buffer
  clientId: string
  messageId: string
}

export function buildSendBody(input: SendBodyInput): BuiltSend {
  const clientId = uuid()
  const messageId = nextMessageId()
  const now = Date.now()

  const content = JSON.stringify({
    aweType: 700,
    type: 0,
    richTextInfos: [],
    text: input.text
  })

  const kv = (key: string, value: string): Buffer =>
    Buffer.concat([fBytes(1, key), fBytes(2, value)])

  const message = Buffer.concat([
    fBytes(1, input.conversationId),
    fVarint(2, 1),
    fVarint(3, messageId),
    fBytes(4, content),
    kv('a:chat_bubble', '{"bubble_id":"0","bubble_source":"1"}'),
    kv('s:mentioned_users', ''),
    kv('s:client_message_id', clientId),
    kv('s:stime', `${now}.5`),
    fVarint(6, 7),
    fBytes(7, Buffer.from(input.conversationToken, 'latin1')),
    fBytes(8, clientId)
  ])

  const payload = fBytes(100, message)

  const body = Buffer.concat([
    fVarint(1, 100),
    fVarint(2, 10018),
    fBytes(3, '0.1.8'),
    fBytes(4, Buffer.alloc(0)),
    fVarint(5, 3),
    fVarint(6, 0),
    fBytes(7, '0d50935:feat/pc-im-group'),
    fBytes(8, payload),
    fBytes(9, '0'),
    fBytes(11, 'douyin_pc'),
    fBytes(14, '360000'),
    // token 与设备参数必须一起带：服务端会用 identity_security_device_id / session_did
    // 去校验 token，缺了就直接报 "empty token"
    kv('identity_security_token', input.identityToken),
    DEVICE_PARAMS
  ])

  return { body, clientId, messageId: messageId.toString() }
}
