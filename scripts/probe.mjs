#!/usr/bin/env node
/**
 * 抖音 Web 接口体检 / 抓包回放工具
 *
 * 用途：
 *   1) 验证你粘贴的 Cookie 是否真的有效（打真实端点，看 status_code）
 *   2) 回放你从浏览器 DevTools 复制的 cURL，用来发现**真实**的接口路径、参数与响应结构
 *   3) 测试签名参数（a_bogus/msToken）的有效期
 *
 * 隐私：
 *   - 默认输出会隐藏 cookie 值与签名类参数值，报告可直接分享；
 *   - 不会把 Cookie 写到任何地方，也不会发往第三方，只发往 douyin.com。
 *
 * 用法：
 *   node scripts/probe.mjs                                  # 用默认 cookie 文件做登录体检
 *   node scripts/probe.mjs --cookie-file ~/dy-cookie.txt
 *   node scripts/probe.mjs --curl ~/Desktop/req.txt         # 回放抓到的请求
 *   node scripts/probe.mjs --curl - < req.txt               # 从标准输入读
 *   node scripts/probe.mjs --curl req.txt --times 3 --interval 2000
 *   node scripts/probe.mjs --curl req.txt --json > report.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_COOKIE_FILE = join(homedir(), '.douyin-chat-cookie.txt')
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const BASE = 'https://www.douyin.com'
// 实测可用：未登录时稳定返回 status_code=8，适合做登录态体检
const LOGIN_PROBE = `${BASE}/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web`

const SECRET_QUERY = new Set(['a_bogus', 'msToken', 'X-Bogus', 'x-bogus', 'verifyFp', 'fp', 'webid', 'odin_tt'])

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

function die(msg, code = 2) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(code)
}

function readInput(file) {
  if (file === '-') {
    try {
      return readFileSync(0, 'utf8')
    } catch {
      die('无法从标准输入读取，请检查管道')
    }
  }
  const path = file.replace(/^~(?=$|\/)/, homedir())
  if (!existsSync(path)) die(`文件不存在：${path}`)
  return readFileSync(path, 'utf8')
}

function getCookie(args) {
  if (args['cookie-file']) return readInput(args['cookie-file']).trim()
  if (process.env.DOUYIN_COOKIE) return process.env.DOUYIN_COOKIE.trim()
  if (existsSync(DEFAULT_COOKIE_FILE)) return readFileSync(DEFAULT_COOKIE_FILE, 'utf8').trim()
  die(
    `未找到 Cookie。请任选一种：\n` +
      `  1) 把 cookie 存到 ${DEFAULT_COOKIE_FILE}\n` +
      `  2) 设置环境变量 DOUYIN_COOKIE\n` +
      `  3) 用 --cookie-file <path> 指定文件\n` +
      `  4) 用 --curl <file> 直接回放浏览器里复制出来的请求\n\n` +
      `获取方式：浏览器登录 douyin.com → 开发者工具 → Network → 任意请求 → 右键 Copy as cURL`
  )
}

/** 解析 ANSI-C 转义（Chrome 的 Copy as cURL 用 $'...' 保存二进制请求体） */
function unescapeAnsiC(raw) {
  const bytes = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'))
      continue
    }
    const n = raw[++i]
    if (n === undefined) break
    const map = { n: 10, r: 13, t: 9, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, '0': 0 }
    if (n === 'x') {
      const hex = raw.slice(i + 1, i + 3)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    if (n === 'u') {
      const hex = raw.slice(i + 1, i + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        bytes.push(...Buffer.from(String.fromCharCode(parseInt(hex, 16)), 'utf8'))
        i += 4
        continue
      }
    }
    if (/[0-7]/.test(n)) {
      const oct = raw.slice(i, i + 3)
      if (/^[0-7]{1,3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8) & 0xff)
        i += oct.length - 1
        continue
      }
    }
    if (map[n] !== undefined) bytes.push(map[n])
    else bytes.push(...Buffer.from(n, 'utf8'))
  }
  return Buffer.from(bytes).toString('latin1')
}

/**
 * 切词：支持 '...'、"..."、$'...'（ANSI-C）与续行符。
 * 二进制请求体用 latin1 保存，保证字节不丢失。
 */
function tokenize(input) {
  const s = input.replace(/\\\r?\n/g, ' ')
  const tokens = []
  let cur = ''
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote === 'ansi') {
      if (c === "'") {
        quote = null
      } else if (c === '\\') {
        // 保留转义序列，交给 unescapeAnsiC 处理
        let j = i + 1
        if (s[j] === 'x') j += 3
        else if (s[j] === 'u') j += 5
        else if (/[0-7]/.test(s[j] ?? '')) j += 2
        else j += 1
        cur += s.slice(i, j + 1)
        i = j
      } else {
        cur += c
      }
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
      continue
    }
    if (c === '$' && s[i + 1] === "'") {
      quote = 'ansi'
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        tokens.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur) tokens.push(cur)
  return tokens.map((t) => (t.includes('\\x') || t.includes('\\0') ? unescapeAnsiC(t) : t))
}

export function parseCurl(input) {
  const tokens = tokenize(input)
  if (!tokens.length || !/^curl$/i.test(tokens[0])) die('这不是一条 curl 命令（应以 curl 开头）')

  let method = null
  let url = null
  let body = null
  const headers = {}

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-X' || t === '--request') {
      method = (tokens[++i] || '').toUpperCase()
    } else if (t === '-H' || t === '--header') {
      const raw = tokens[++i] || ''
      const idx = raw.indexOf(':')
      if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim()
    } else if (t === '-b' || t === '--cookie') {
      headers.cookie = tokens[++i] || ''
    } else if (t === '--data-raw' || t === '--data' || t === '--data-binary' || t === '--data-urlencode') {
      const val = tokens[++i]
      if (val !== undefined) body = body ? `${body}&${val}` : val
    } else if (t === '--compressed' || t === '-s' || t === '--silent' || t === '-k' || t === '--insecure') {
      /* 无需处理 */
    } else if (/^https?:\/\//i.test(t)) {
      url = t
    }
  }

  if (!url) die('没能从 curl 里解析出 URL')
  const upper = (method || (body ? 'POST' : 'GET')).toUpperCase()
  // Chrome 对二进制体会用 $'...'，此时字节以 latin1 保存，发送时必须还原为 Buffer
  const binary = /\$'/.test(input)
  return {
    method: upper,
    url,
    headers,
    body,
    binary,
    bodyBuffer: binary && body ? Buffer.from(body, 'latin1') : undefined
  }
}

function maskCookie(cookie) {
  if (!cookie) return '（无）'
  const parts = cookie.split(';').map((p) => p.trim()).filter(Boolean)
  const names = parts.map((p) => p.split('=')[0])
  return `${parts.length} 个字段：${names.join(', ')}`
}

function maskUrl(raw) {
  try {
    const u = new URL(raw)
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_QUERY.has(key) || /token|sign|bogus|fp/i.test(key)) u.searchParams.set(key, '***')
    }
    return u.toString()
  } catch {
    return raw
  }
}

function shape(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    const inner = value.length ? shape(value[0], depth + 1) : 'unknown'
    return `Array(${value.length})<${inner}>`
  }
  if (typeof value === 'object') {
    if (depth >= 2) return '{…}'
    const entries = Object.entries(value).slice(0, 14)
    const body = entries.map(([k, v]) => `${k}: ${shape(v, depth + 1)}`).join(', ')
    return `{ ${body}${Object.keys(value).length > 14 ? ', …' : ''} }`
  }
  if (typeof value === 'string') return `string(${value.length})`
  return typeof value
}


/** 读取 protobuf 响应的外层信封（#1 cmd, #2 子命令, #3 状态码, #4 状态文案） */
function readProtoEnvelope(buf) {
  const out = { cmd: undefined, sub: undefined, status: undefined, message: undefined, fieldCount: 0 }
  let i = 0
  const readVarint = () => {
    let v = 0
    let shift = 0
    while (i < buf.length) {
      const b = buf[i++]
      v += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return v
      shift += 7
      if (shift > 63) throw new Error('varint')
    }
    throw new Error('varint eof')
  }
  try {
    while (i < buf.length) {
      const key = readVarint()
      const fn = key >> 3
      const wt = key & 7
      out.fieldCount++
      if (wt === 0) {
        const v = readVarint()
        if (fn === 1) out.cmd = v
        if (fn === 2) out.sub = v
        if (fn === 3) out.status = v
      } else if (wt === 2) {
        const len = readVarint()
        if (i + len > buf.length) break
        if (fn === 4) out.message = buf.subarray(i, i + len).toString('utf8')
        i += len
      } else if (wt === 5) i += 4
      else if (wt === 1) i += 8
      else break
      if (out.fieldCount > 12) break
    }
  } catch {
    /* 保持部分结果 */
  }
  return out
}

/** 对 protobuf 响应的判定 */
function judgeProto(status, buf) {
  if (status === 401 || status === 403) {
    return { ok: false, code: 'HTTP_' + status, reason: '请求被拒绝（未登录或缺少权限）' }
  }
  if (status >= 500) return { ok: false, code: 'SERVER', reason: `服务端异常（HTTP ${status}）` }
  const env = readProtoEnvelope(buf)
  const meta = { protoStatus: env.status, protoMessage: env.message, cmd: env.cmd }
  if (env.status === 0 || env.message === 'OK') {
    return { ok: true, code: 'OK', reason: '接口返回成功', ...meta }
  }
  return {
    ok: false,
    code: 'BIZ',
    reason: `protobuf 回执 status=${env.status ?? '?'}${env.message ? ' / ' + env.message : ''}`,
    ...meta
  }
}

function judge(status, contentType, text) {
  if (status === 401 || status === 403) {
    return { ok: false, code: 'HTTP_' + status, reason: '请求被拒绝：通常是缺少签名参数或触发风控' }
  }
  if (status === 429) return { ok: false, code: 'RATE_LIMITED', reason: '触发频率限制' }
  if (status >= 500) return { ok: false, code: 'SERVER', reason: `服务端异常（HTTP ${status}）` }
  if (/text\/html/i.test(contentType) || /^\s*</.test(text)) {
    return { ok: false, code: 'HTML', reason: '返回 HTML 页面（多为验证码 / 风控页），不是接口数据' }
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, code: 'NON_JSON', reason: '响应不是 JSON，可能被网关拦截' }
  }
  const code = json.status_code
  const meta = { statusCode: code, statusMsg: typeof json.status_msg === 'string' ? json.status_msg : undefined }
  if (code === 0) {
    if (json.data === null && /url doesn't match/i.test(json.status_msg || '')) {
      return { ok: false, code: 'BAD_PATH', reason: "路径不存在（服务端提示 url doesn't match）", ...meta }
    }
    return { ok: true, code: 'OK', reason: '接口返回成功', ...meta }
  }
  if ([8, 10008, 2154, 2096].includes(code)) {
    return { ok: false, code: 'AUTH', reason: `status_code=${code}：未登录 / 登录态无效（缺签名时也会落到这里）`, ...meta }
  }
  if ([5, 10015, 10016].includes(code)) {
    return { ok: false, code: 'RATE_LIMITED', reason: `status_code=${code}：被限流`, ...meta }
  }
  return { ok: false, code: 'BIZ', reason: `status_code=${code}：${json.status_msg ?? '业务异常'}`, ...meta }
}

async function replay({ method, url, headers, body, bodyBuffer }, timeout = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const started = Date.now()
  const finalHeaders = { 'user-agent': UA, referer: 'https://www.douyin.com/', ...headers }
  delete finalHeaders['content-length']
  delete finalHeaders['Content-Length']
  delete finalHeaders['accept-encoding']
  if (body && !Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'content-type')) {
    finalHeaders['content-type'] = 'application/x-www-form-urlencoded'
  }

  try {
    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : (bodyBuffer ?? body ?? ''),
      signal: controller.signal,
      redirect: 'follow'
    })
    const contentType = res.headers.get('content-type') ?? ''
    if (/protobuf/i.test(contentType)) {
      const buf = Buffer.from(await res.arrayBuffer())
      return {
        status: res.status,
        contentType,
        ms: Date.now() - started,
        bytes: buf.length,
        text: '',
        proto: readProtoEnvelope(buf),
        verdict: judgeProto(res.status, buf)
      }
    }
    const text = await res.text()
    return {
      status: res.status,
      contentType,
      ms: Date.now() - started,
      bytes: Buffer.byteLength(text),
      text,
      verdict: judge(res.status, contentType, text)
    }
  } catch (err) {
    return {
      status: 0,
      contentType: '',
      ms: Date.now() - started,
      bytes: 0,
      text: '',
      verdict: { ok: false, code: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', reason: String(err.message || err) }
    }
  } finally {
    clearTimeout(timer)
  }
}

function printReport(report, args) {
  const jsonMode = Boolean(args.json)
  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2))
    return
  }

  const line = (s = '') => console.log(s)
  line()
  line('抖音 Web 接口体检报告')
  line('='.repeat(58))
  line(`时间        ${report.at}`)
  line(`方式        ${report.request.method} ${report.request.path}`)
  line(`Cookie      ${report.cookieMasked}`)
  line(`签名参数    ${report.signatureParams.length ? report.signatureParams.join(', ') : '未检测到（a_bogus / msToken）'}`)
  if (report.request.bodyBytes) line(`请求体      ${report.request.bodyBytes} 字节`)
  line()

  report.attempts.forEach((a, i) => {
    line(`第 ${i + 1} 次请求`)
    line(`  HTTP      ${a.status || '—'} ${a.contentType ? '· ' + a.contentType : ''} · ${a.ms}ms · ${a.bytes}B`)
    if (a.statusCode !== undefined) line(`  业务码    status_code=${a.statusCode}`)
    if (a.statusMsg) line(`  提示      ${a.statusMsg}`)
    if (a.proto) line(`  回执      cmd=${a.proto.cmd} status=${a.proto.status} fields=${a.proto.fieldCount}`)
    if (a.shape) line(`  结构      ${a.shape}`)
    line(`  判定      ${a.verdict.ok ? '✅' : '❌'} ${a.verdict.reason}`)
    if (args['show-body'] && a.bodyPreview) {
      line('  正文      ' + a.bodyPreview.replace(/\s+/g, ' ').slice(0, 400))
    }
    line()
  })

  line('结论')
  line('-'.repeat(58))
  for (const c of report.conclusions) line(`· ${c}`)
  line()
  if (!args['show-body']) {
    line('（已自动隐藏 Cookie 与签名参数值，本报告可直接分享）')
    line()
  }
}

function conclusionsFor(report) {
  const out = []
  const first = report.attempts[0]
  if (!first) return out
  const v = first.verdict
  if (v.code === 'OK') {
    out.push('该请求在当前 Cookie（及原样签名）下可用。')
    if (report.signatureParams.length) {
      out.push('注意：a_bogus 与 URL/body 绑定且通常几分钟内失效，不能作为长期方案。')
    } else {
      out.push('该接口不依赖签名参数，可考虑直接接入客户端。')
    }
    out.push('请把本报告（含 path 与字段结构）回传，可据此修正客户端的端点表。')
  } else if (v.code === 'AUTH') {
    out.push('登录态无效：确认 cookie 中包含 sessionid 与 sessionid_ss，且复制时未截断。')
    out.push('若 Cookie 确认有效，则该接口还要求签名参数（a_bogus/msToken）。')
  } else if (v.code === 'BAD_PATH') {
    out.push('路径不对：服务端不认这个 URL，需要从浏览器 Network 面板复制真实请求。')
  } else if (v.code === 'HTML') {
    out.push('被风控页拦截：缺少签名或被判定为异常流量。')
  } else if (v.code === 'RATE_LIMITED') {
    out.push('触发限流：降低频率，或稍后重试。')
  } else {
    out.push(`请求未成功：${v.reason}`)
  }
  if (report.attempts.length > 1) {
    const okFirst = report.attempts[0].verdict.ok
    const okLast = report.attempts[report.attempts.length - 1].verdict.ok
    if (okFirst && !okLast) out.push('重复请求后失效：说明签名/令牌有有效期，进一步证明需要实时签名来源。')
  }
  return out
}



/** 从 postData 中只提取字段名；JSON 体取顶层 key，绝不再把值当 key 打印 */
function extractBodyNames(postData) {
  if (!postData) return []
  let names = []
  if (Array.isArray(postData.params)) {
    names = postData.params.map((p) => p?.name).filter(Boolean)
  } else if (typeof postData.text === 'string') {
    const text = postData.text.trim()
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        names = Array.isArray(parsed) ? ['[array]'] : Object.keys(parsed)
      } catch {
        names = ['[unparsed-json]']
      }
    } else {
      try {
        names = [...new URLSearchParams(text).keys()]
      } catch {
        names = []
      }
    }
  }
  // 只保留像字段名的短 token，避免把值/整段 JSON 混进报告
  return names.filter((n) => typeof n === 'string' && n.length <= 40 && /^[A-Za-z0-9_.\-\[\]]+$/.test(n))
}

function topKeys(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(text)
    return Object.keys(parsed).slice(0, 10)
  } catch {
    return undefined
  }
}

/** 从 HAR 中提取抖音的 XHR/fetch 请求（只保留结构，不含任何值） */
export function summarizeHar(har) {
  const entries = har?.log?.entries ?? []
  const rows = []
  const seen = new Set()
  for (const entry of entries) {
    const req = entry?.request
    if (!req?.url) continue
    let url
    try {
      url = new URL(req.url)
    } catch {
      continue
    }
    if (!/(^|\.)douyin\.com$/.test(url.hostname)) continue
    if (!/\/(aweme|api|passport)\//.test(url.pathname)) continue
    const key = `${req.method} ${url.pathname}`
    if (seen.has(key)) continue
    seen.add(key)

    const queryNames = [...url.searchParams.keys()]
    let bodyNames = extractBodyNames(req.postData)
    const respText = entry?.response?.content?.text
    let bizCode
    if (typeof respText === 'string' && respText.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(respText)
        if (typeof parsed.status_code === 'number') bizCode = parsed.status_code
      } catch {
        /* ignore */
      }
    }
    rows.push({
      method: req.method,
      path: url.pathname,
      status: entry?.response?.status,
      bizCode,
      queryNames,
      bodyNames,
      respKeys: topKeys(respText),
      signature: queryNames.filter((n) => SECRET_QUERY.has(n) || /bogus|msToken/i.test(n))
    })
  }
  return rows.sort((a, b) => {
    const ai = a.path.includes('/im/') ? 0 : 1
    const bi = b.path.includes('/im/') ? 0 : 1
    return ai - bi || a.path.localeCompare(b.path)
  })
}

function printHarTable(rows) {
  console.log('\nHAR 端点清单（已脱敏：只含路径/参数名，不含任何值）')
  console.log('='.repeat(72))
  if (!rows.length) {
    console.log('未发现抖音接口请求。请确认导出 HAR 前已打开私信页面并操作过。\n')
    return
  }
  const imRows = rows.filter((r) => r.path.includes('/im/'))
  console.log(`共 ${rows.length} 个去重端点，其中 /im/ 相关 ${imRows.length} 个\n`)
  for (const r of rows) {
    console.log(`${r.method.padEnd(5)} ${r.path}`)
    const meta = [`HTTP ${r.status}`]
    if (r.bizCode !== undefined) meta.push(`status_code=${r.bizCode}`)
    if (r.signature.length) meta.push(`签名=${r.signature.join('/')}`)
    console.log(`      ${meta.join(' · ')}`)
    if (r.queryNames.length) console.log(`      query: ${r.queryNames.join(', ')}`)
    if (r.bodyNames.length) console.log(`      body : ${r.bodyNames.join(', ')}`)
    if (r.respKeys?.length) console.log(`      resp : ${r.respKeys.join(', ')}`)
    console.log()
  }
}


/**
 * 最小 IM 请求信封（protobuf）：
 * #1=2001 #2=10020 #3="0.1.8" #4=空 —— 实测可被 imapi 接受并进入会话校验
 */
function minimalImEnvelope() {
  const part = (fieldNo, payload) => {
    const key = Buffer.from([(fieldNo << 3) | 2])
    const len = Buffer.from([payload.length])
    return Buffer.concat([key, len, payload])
  }
  const varint = (fieldNo, value) => {
    const bytes = []
    let v = value
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    bytes.push(v)
    return Buffer.concat([Buffer.from([(fieldNo << 3) | 0]), Buffer.from(bytes)])
  }
  return Buffer.concat([
    varint(1, 2001),
    varint(2, 10020),
    part(3, Buffer.from('0.1.8')),
    part(4, Buffer.alloc(0))
  ])
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.har) {
    let har
    try {
      har = JSON.parse(readInput(args.har))
    } catch {
      die('HAR 解析失败：请确认导出的是 .har 文件')
    }
    const rows = summarizeHar(har)
    if (args.json) {
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), endpoints: rows }, null, 2))
      return
    }
    printHarTable(rows)
    return
  }

  let request
  let cookieMasked
  if (args.curl) {
    const parsed = parseCurl(readInput(args.curl))
    request = parsed
    cookieMasked = maskCookie(parsed.headers.cookie)
    if (!parsed.headers.cookie) {
      console.warn('⚠ 这条 curl 里没有 cookie，请求大概率返回未登录。')
    }
  } else {
    const cookie = getCookie(args)
    cookieMasked = maskCookie(cookie)
    if (args['im-ping']) {
      // 直接打真实 IM 网关，验证会话是否被接受
      request = {
        method: 'POST',
        url: 'https://imapi.douyin.com/v1/message/get_message_by_init',
        headers: {
          cookie,
          'content-type': 'application/x-protobuf',
          accept: 'application/x-protobuf',
          origin: 'https://www.douyin.com',
          referer: 'https://www.douyin.com/'
        },
        body: '',
        bodyBuffer: minimalImEnvelope()
      }
    } else {
      request = {
        method: 'GET',
        url: LOGIN_PROBE,
        headers: { cookie },
        body: null
      }
    }
  }

  const url = new URL(request.url)
  const signatureParams = [...url.searchParams.keys()].filter((k) => SECRET_QUERY.has(k) || /bogus|msToken/i.test(k))
  const times = Math.max(1, Math.min(10, Number(args.times ?? 1)))
  const interval = Math.max(0, Number(args.interval ?? 0))

  const attempts = []
  for (let i = 0; i < times; i++) {
    if (i > 0 && interval) await new Promise((r) => setTimeout(r, interval))
    const res = await replay(request)
    // 只在需要时解析响应结构；默认报告不携带任何响应内容
    let parsedJson
    try {
      parsedJson = res.text ? JSON.parse(res.text) : undefined
    } catch {
      parsedJson = undefined
    }
    attempts.push({
      status: res.status,
      contentType: res.contentType,
      ms: res.ms,
      bytes: res.bytes,
      statusCode: res.verdict.statusCode ?? res.verdict.protoStatus,
      statusMsg: res.verdict.statusMsg ?? res.verdict.protoMessage,
      shape: parsedJson ? shape(parsedJson) : undefined,
      bodyPreview: args['show-body'] ? res.text : undefined,
      verdict: { ok: res.verdict.ok, code: res.verdict.code, reason: res.verdict.reason }
    })
  }

  const report = {
    at: new Date().toISOString(),
    request: {
      method: request.method,
      path: url.pathname + (url.search ? '?…' : ''),
      url: maskUrl(request.url),
      bodyBytes: request.bodyBuffer ? request.bodyBuffer.length : Buffer.byteLength(request.body ?? ''),
      headerNames: Object.keys(request.headers)
    },
    cookieMasked,
    signatureParams,
    attempts,
    conclusions: []
  }
  report.conclusions = conclusionsFor(report)

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(report, null, 2))
  }
  printReport(report, args)
}

main().catch((err) => {
  console.error('\n✗ 执行失败：', err?.message ?? err)
  process.exit(1)
})
