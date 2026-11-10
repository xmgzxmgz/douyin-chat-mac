import { BrowserWindow, session } from 'electron'
import { AppError } from '../../core/errors'
import type { Logger } from '../../core/notifier'
import { ImCollector, type IngestStats } from './im-collector'

/**
 * 把抖音网页当作「传输层」。
 *
 * 背景：imapi.douyin.com 的请求体里有一个页面侧运行时生成的 token（缺失时报
 * `empty token`），它既不在 Cookie 里，也不在 localStorage 里，逆推代价高且易失效。
 *
 * 本模块的做法：用一个隐藏的、已登录的 BrowserWindow 打开私信页，**让页面自己发请求**，
 * 通过 CDP（Network.getResponseBody / webSocketFrameReceived）把响应体取回来，
 * 交给 ImCollector 解码。全程不读浏览器 Cookie、不伪造 token。
 */

const PARTITION = 'persist:douyin-im'
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

/** 依次尝试的私信页地址；实测 `/user/self?showTab=message` 才会初始化 IM */
const ROUTE_CANDIDATES = [
  'https://www.douyin.com/user/self?showTab=message',
  'https://www.douyin.com/messages',
  'https://www.douyin.com/'
]

export interface BridgeOptions {
  logger?: Logger
  userAgent?: string
  partition?: string
  /** 收到新数据时回调（用于即时触发一次同步） */
  onData?: (stats: IngestStats) => void
}

export class ImWebBridge {
  private readonly collector: ImCollector
  private win: BrowserWindow | null = null
  private attached = false
  private readonly pendingResponses = new Map<string, { path: string; priority: boolean }>()
  private lastImHeaders: Record<string, string> | null = null
  private headerNamesLogged = false
  private imPostSample: { path: string; bytes: number; hex: string } | null = null
  /** 页面请求用户资料时抓到的原始请求（昵称的唯一来源） */
  private userInfoSample: {
    url: string
    method: string
    body: string
    headers: Record<string, string>
  } | null = null
  private readonly bodyQueue: Array<{ requestId: string; path: string }> = []
  private draining = false
  private bodyFailures = 0
  private bodyOk = 0
  private readonly bodyErrorPaths = new Map<string, number>()
  private imapiSeen = 0
  private readonly hosts = new Map<string, number>()
  private selfId = ''
  private route = ''
  private readonly wsUrls = new Map<string, string>()
  private readonly logger?: Logger
  private readonly userAgent: string
  private readonly partition: string

  constructor(private readonly opts: BridgeOptions = {}) {
    this.logger = opts.logger
    this.userAgent = opts.userAgent ?? DEFAULT_UA
    this.partition = opts.partition ?? PARTITION
    this.collector = new ImCollector(() => this.selfId)
  }

  setSelfId(id: string): void {
    this.selfId = id
  }

  get alive(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.attached)
  }

  stats(): ReturnType<ImCollector['stats']> & { route: string; body: string } {
    return { ...this.collector.stats(), route: this.route, body: this.bodyStats() }
  }

  /**
   * 页面最近一次 imapi 请求的完整请求头（含网关要求的 token）。
   * 若将来要绕过页面直连发送，可复用这里的头，避免逆向 token 生成。
   */
  imRequestHeaders(): Record<string, string> | null {
    return this.lastImHeaders
  }

  /** 页面最近一次 imapi 请求体样本（hex，仅本地诊断） */
  imRequestSample(): { path: string; bytes: number; hex: string } | null {
    return this.imPostSample
  }

  /**
   * 在前端 JS 里找「发送消息」的接口与 protobuf 定义（只读探测，不发送）。
   * 目的：拿到 /v1/message/send 对应的 cmd 常量与字段名，避免靠猜。
   */
  async probeSendEndpoint(): Promise<{ total: number; hits: Array<{ url: string; snip: string }>; editables?: unknown; url?: string }> {
    const wc = this.win?.webContents
    if (!wc) return { total: 0, hits: [] }
    const script = `
      (async () => {
        const editables = [...document.querySelectorAll('[contenteditable="true"], textarea')].map((el) => ({
          tag: el.tagName,
          hint: (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '').slice(0, 20),
          cls: (el.className || '').toString().slice(0, 40)
        }))
        const fromScripts = [...document.querySelectorAll('script[src]')].map((s) => s.src)
        const fromPerf = performance.getEntriesByType('resource').map((e) => e.name)
        const uniq = [...new Set([...fromScripts, ...fromPerf])]
          .filter((u) => /^https?:/.test(u) && /\.js(\?|$)/.test(u))
          .slice(0, 80)
        const hits = []
        for (const u of uniq) {
          try {
            const text = await (await fetch(u)).text()
            for (const needle of ['message/send', 'send_message', 'SendMessageRequest']) {
              const i = text.indexOf(needle)
              if (i >= 0) {
                hits.push({ url: u.split('/').pop() || u, snip: text.slice(Math.max(0, i - 160), i + 220) })
                break
              }
            }
          } catch (e) {}
        }
        return { total: uniq.length, hits: hits.slice(0, 4), editables, url: location.href.slice(0, 120) }
      })()
    `
    try {
      return (await withTimeout(wc.executeJavaScript(script), 30_000, '探测超时')) as {
        total: number
        hits: Array<{ url: string; snip: string }>
        editables?: unknown
        url?: string
      }
    } catch (err) {
      this.logger?.warn(`探测发送接口失败：${(err as Error).message}`)
      return { total: 0, hits: [] }
    }
  }

  /** 等页面的用户资料请求出现（首屏后几百毫秒） */
  private async waitForUserInfoSample(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.userInfoSample) return true
      await delay(300)
    }
    return Boolean(this.userInfoSample)
  }

  /**
   * 批量取昵称：用页面自己的 fetch 调「用户资料」接口。
   *
   * 为什么可行：该接口只要 Cookie，不需要 a_bogus（已实测 status_code=0）。
   * 请求体只有一个字段 `sec_user_ids`，值是要查的 sec_uid 列表。
   */
  async fetchUserNames(
    secUids: string[]
  ): Promise<Array<{ uid?: string; secUid?: string; nickname?: string; avatar?: string }>> {
    const wc = this.win?.webContents
    if (!wc || !secUids.length) return []
    // 页面自己一次只查 40 个，超过会被拒（实测 60 个直接返回空）
    const ids = secUids.slice(0, 40)

    // 页面在首屏之后才发这条请求；补昵称往往比它更早，先等模板出现
    if (!this.userInfoSample && !(await this.waitForUserInfoSample(8000))) {
      this.logger?.warn('BRIDGE 取昵称：仍未见页面的用户资料请求，跳过本轮')
      return []
    }
    const sample = this.userInfoSample
    if (!sample) return []

    const bodies = [
      `sec_user_ids=${encodeURIComponent(JSON.stringify(ids))}`,
      `sec_user_ids=${encodeURIComponent(ids.join(','))}`
    ]

    for (const [attempt, body] of bodies.entries()) {
      const script = `
        (async () => {
          try {
            const res = await fetch(${JSON.stringify(sample.url)}, {
              method: ${JSON.stringify(sample.method)},
              credentials: 'include',
              headers: ${JSON.stringify(sample.headers)},
              body: ${JSON.stringify(body)}
            });
            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) {}
            if (!json) return { status: res.status, items: [], code: -1 };
            const out = [];
            const walk = (n) => {
              if (!n || typeof n !== 'object') return;
              if (Array.isArray(n)) { for (const x of n) walk(x); return; }
              const uid = n.uid || n.user_id || n.userId;
              const sec = n.sec_uid || n.secUid || n.sec_user_id;
              const nick = n.nickname || n.nick_name;
              if (typeof nick === 'string' && nick && (uid || sec)) {
                const av = (n.avatar_thumb && n.avatar_thumb.url_list && n.avatar_thumb.url_list[0]) || n.avatar_url || '';
                out.push({
                  uid: uid ? String(uid) : undefined,
                  secUid: sec ? String(sec) : undefined,
                  nickname: nick,
                  avatar: typeof av === 'string' ? av : ''
                });
              }
              for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
            };
            walk(json);
            return { status: res.status, code: json.status_code, items: out.slice(0, 200) };
          } catch (err) {
            return { status: 0, items: [], code: -1 };
          }
        })()
      `
      try {
        const out = (await withTimeout(wc.executeJavaScript(script), 15_000, '取昵称超时')) as {
          status: number
          code: number
          items: Array<{ uid?: string; secUid?: string; nickname?: string; avatar?: string }>
        }
        this.logger?.info(
          `BRIDGE 取昵称[${attempt}] 请求 ${ids.length} 个 → status=${out.status} code=${out.code} items=${out.items?.length ?? 0}`
        )
        if (out.items?.length) return out.items
        this.logger?.debug(`BRIDGE 取昵称未命中（status=${out.status} code=${out.code}），尝试下一种请求体`)
      } catch (err) {
        this.logger?.warn(`BRIDGE 取昵称失败：${(err as Error).message}`)
        return []
      }
    }
    return []
  }
  async replayUserInfo(): Promise<{
    ok: boolean
    status?: number
    keys?: string[]
    named?: number
    bodyKeys?: string[]
    error?: string
  }> {
    const wc = this.win?.webContents
    const sample = this.userInfoSample
    if (!wc || !sample) return { ok: false, error: '未捕获到用户资料请求' }

    const script = `
      (async () => {
        try {
          const res = await fetch(${JSON.stringify(sample.url)}, {
            method: ${JSON.stringify(sample.method)},
            credentials: 'include',
            headers: ${JSON.stringify(sample.headers)},
            body: ${JSON.stringify(sample.body)}
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch (e) {}
          const hits = [];
          const walk = (n) => {
            if (!n || typeof n !== 'object') return;
            if (Array.isArray(n)) { for (const x of n) walk(x); return; }
            const id = n.uid || n.user_id || n.userId;
            if (id && typeof n.nickname === 'string' && n.nickname) hits.push(String(id));
            for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
          };
          if (json) walk(json);
          return {
            status: res.status,
            keys: json && typeof json === 'object' && !Array.isArray(json) ? Object.keys(json).slice(0, 12) : [],
            named: hits.length,
            uids: hits.slice(0, 200)
          };
        } catch (err) {
          return { status: 0, keys: [], named: 0, error: String(err && err.message ? err.message : err) };
        }
      })()
    `
    try {
      const out = (await withTimeout(wc.executeJavaScript(script), 15_000, '重放超时')) as {
        status?: number
        keys?: string[]
        named?: number
        uids?: string[]
        error?: string
      }
      if (out.error) return { ok: false, status: out.status, error: out.error }
      return {
        ok: (out.named ?? 0) > 0,
        status: out.status,
        keys: out.keys,
        named: out.named,
        bodyKeys: bodyShape(sample.body)
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  snapshot(): ReturnType<ImCollector['snapshot']> {
    return this.collector.snapshot()
  }

  since(cursor: number): ReturnType<ImCollector['since']> {
    return this.collector.since(cursor)
  }

  /** 还没拿到昵称、需要查询的 sec_uid */
  pendingSecUids(limit = 40): string[] {
    return this.collector.unresolvedSecUids(limit)
  }

  /** 写入昵称/头像，返回新增数量 */
  applyProfiles(
    items: Array<{ uid?: string; secUid?: string; nickname?: string; avatar?: string }>
  ): number {
    return this.collector.setProfiles(items)
  }

  // ---------------- 生命周期 ----------------

  async start(): Promise<void> {
    if (this.alive) return
    await this.assertLoggedIn()
    this.logger?.info('BRIDGE 会话有效，创建隐藏窗口')
    this.createWindow()
    // 预热：必须先让 douyin.com 真正加载完成，再附加调试通道。
    // 从 about:blank 跨进程切到 douyin 时 DevTools 会换 agent，之前拿到的 requestId
    // 全部失效（实测报 No resource with given identifier），首屏的 init 包会取不到。
    await this.load('https://www.douyin.com/')
    await this.attach()
    const ok = await this.navigateUntilData()
    if (!ok) {
      this.logger?.warn('BRIDGE 自动导航未取到 IM 数据，改为显示窗口等待手动进入私信页')
      this.showWindow()
      const manual = await this.waitForData(90_000)
      if (!manual) {
        throw new AppError(
          'UNSUPPORTED',
          '未能从页面捕获到私信数据。请在弹出的窗口里登录并点开一次「私信」，或确认账号可正常使用网页版私信。'
        )
      }
    }
    const s = this.collector.stats()
    this.logger?.info(`BRIDGE 就绪：${this.route || '手动导航'} · 会话 ${s.conversations} · 消息 ${s.messages}`)
  }

  async stop(): Promise<void> {
    const win = this.win
    this.win = null
    if (!win || win.isDestroyed()) return
    try {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    } catch {
      /* ignore */
    }
    this.attached = false
    win.destroy()
  }

  /** 供用户手动点「私信」时使用 */
  showWindow(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show()
      this.win.focus()
    }
  }

  private async assertLoggedIn(): Promise<void> {
    const ses = session.fromPartition(this.partition)
    const cookies = await ses.cookies.get({ name: 'sessionid' })
    const hit = cookies.find((c) => c.domain?.endsWith('douyin.com') && c.value.length > 20)
    if (!hit) {
      throw new AppError('AUTH_REQUIRED', '页面会话已失效，请重新登录后重试')
    }
  }

  private createWindow(): void {
    this.win = new BrowserWindow({
      show: false,
      width: 1180,
      height: 820,
      title: '抖音私信同步（请勿关闭）',
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: this.partition,
        nodeIntegration: false,
        contextIsolation: true,
        // 注意：这里必须是 false。子窗口若以 sandbox:true 运行，在 --no-sandbox 的
        // 宿主下 DevTools target 不可用，Network.enable 会静默挂起（已实测）。
        sandbox: false,
        // 隐藏窗口默认会被节流，页面就不会继续轮询
        backgroundThrottling: false,
        webSecurity: true
      }
    })
    this.win.webContents.setUserAgent(this.userAgent)
    this.win.webContents.setAudioMuted(true)
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.win.on('closed', () => {
      this.win = null
      this.attached = false
    })
    // 用户在窗口里手动操作时，保持会话
    this.win.on('close', () => {
      /* 允许关闭：下次 start() 会重建 */
    })
  }

  private async attach(): Promise<void> {
    const wc = this.win?.webContents
    if (!wc) throw new AppError('SERVER', '浏览器窗口未创建')
    try {
      wc.debugger.attach('1.3')
    } catch (err) {
      throw new AppError('SERVER', `无法连接页面调试通道：${(err as Error).message}`)
    }
    this.attached = true
    this.logger?.info('BRIDGE 调试通道已附加')
    wc.debugger.on('message', this.onCdpMessage)
    wc.debugger.on('detach', (_e, reason) => {
      this.attached = false
      this.logger?.warn(`BRIDGE 调试通道断开：${reason}`)
    })
    await withTimeout(
      this.cdp('Network.enable', {
        maxTotalBufferSize: 200 * 1024 * 1024,
        maxResourceBufferSize: 60 * 1024 * 1024,
        maxPostDataSize: 8 * 1024 * 1024
      }),
      10_000,
      'Network.enable 超时'
    )
    this.logger?.info('BRIDGE 网络监听已启用')
  }

  private cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const wc = this.win?.webContents
    if (!wc || !wc.debugger.isAttached()) {
      return Promise.reject(new Error('调试通道未就绪'))
    }
    return wc.debugger.sendCommand(method, params) as Promise<T>
  }

  // ---------------- 抓取 ----------------

  private readonly onCdpMessage = (_event: Electron.Event, method: string, params: unknown): void => {
    const p = params as Record<string, unknown>
    // 记录页面自己发出的 imapi 请求头（只记名称，不记值），
    // 用于判断网关要求的 token 到底在哪个 header——这是能否直连发送的前提
    if (method === 'Network.requestWillBeSent') {
      const req = p.request as
        | {
            url?: string
            method?: string
            headers?: Record<string, string>
            postData?: string
          }
        | undefined
      const reqUrl = String(req?.url ?? '')

      // 页面加载私信时一定会请求用户资料（昵称的唯一来源）；存一份原始请求用于重放
      if (/\/web\/im\/user\/info\//.test(reqUrl) && req?.postData && !this.userInfoSample) {
        const headers = Object.fromEntries(
          Object.entries(req.headers ?? {}).filter(([k]) => /content-type|accept/i.test(k))
        )
        this.userInfoSample = {
          url: reqUrl,
          method: req.method ?? 'POST',
          body: req.postData,
          headers
        }
        this.logger?.info(
          `BRIDGE 已捕获用户资料请求：${pathOf(reqUrl)} · ${req.method} · body ${Buffer.byteLength(req.postData)}B`
        )
      }

      if (!reqUrl.includes('imapi.douyin.com')) return
      if (req?.headers) {
        this.lastImHeaders = req.headers
        if (!this.headerNamesLogged) {
          this.headerNamesLogged = true
          this.logger?.info(`BRIDGE imapi 请求头名称：${Object.keys(req.headers).sort().join(',')}`)
        }
      }
      // 抓一份真实请求体（仅本地诊断用，pull 请求不含聊天内容），用于定位网关要求的 token 字段
      if (req?.postData && !this.imPostSample) {
        this.imPostSample = {
          path: pathOf(reqUrl),
          bytes: Buffer.byteLength(req.postData, 'utf8'),
          hex: Buffer.from(req.postData, 'utf8').toString('hex').slice(0, 3000)
        }
        this.logger?.info(`BRIDGE 已捕获 imapi 请求体样本：${this.imPostSample.path} · ${this.imPostSample.bytes}B`)
      }
      return
    }
    if (method === 'Network.responseReceived') {
      const response = p.response as
        | { url?: string; headers?: Record<string, string>; encodedDataLength?: number }
        | undefined
      const url = response?.url ?? ''
      const path = pathOf(url)
      // imapi 的 protobuf 主链路 + 可能携带用户资料的网页私信 JSON 接口。
      // 不做全量抓取：响应体只能取一次且会被浏览器驱逐，抢在关键包后面会导致 init 取不到。
      const isImapi = url.includes('imapi.douyin.com')
      const isProfileJson = /\/web\/im\/(user\/info|user\/profile|friend|conversation)\//.test(path)
      if (!isImapi && !isProfileJson) return
      this.imapiSeen++
      const host = hostOf(url)
      this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1)
      if (Number(response?.encodedDataLength ?? 0) > 40 * 1024 * 1024) return
      this.logger?.debug(
        `BRIDGE im 响应 #${this.imapiSeen} ${path} · ${headerOf(response?.headers, 'content-type') || '未知类型'}`
      )
      this.enqueueBodyLater(String(p.requestId), path, isImapi)
      return
    }
    // 响应体要等加载结束才可读：init 有数 MB，提前取会得到 No data found
    if (method === 'Network.loadingFinished') {
      const id = String(p.requestId)
      const pending = this.pendingResponses.get(id)
      if (!pending) return
      this.pendingResponses.delete(id)
      this.enqueueBody(id, pending.path, pending.priority)
      return
    }
    if (method === 'Network.loadingFailed') {
      this.pendingResponses.delete(String(p.requestId))
      return
    }
    if (method === 'Network.webSocketCreated') {
      const url = String(p.url ?? '')
      if (url.includes('imapi.douyin.com')) this.wsUrls.set(String(p.requestId), url)
      return
    }
    if (method === 'Network.webSocketFrameReceived') {
      if (!this.wsUrls.has(String(p.requestId))) return
      const data = (p.response as { payloadData?: string } | undefined)?.payloadData
      if (!data) return
      try {
        this.ingest(Buffer.from(data, 'base64'), 'ws')
      } catch {
        /* 非二进制帧 */
      }
    }
  }

  /**
   * 记录待取体的响应，等 loadingFinished 再取。
   * 直接取会失败：Chromium 只在响应体下载完成后才允许 getResponseBody。
   */
  private enqueueBodyLater(requestId: string, path: string, priority: boolean): void {
    if (this.pendingResponses.size > 400) {
      const first = this.pendingResponses.keys().next().value
      if (first) this.pendingResponses.delete(first)
    }
    this.pendingResponses.set(requestId, { path, priority })
  }

  /**
   * 取响应体必须排队，不能因为并发上限就丢弃：
   * 页面一次加载会并发打出几十个请求，被丢掉的往往正是体积最大的 init 响应。
   * imapi 的关键包插队到最前——响应体在浏览器里存活时间很短，晚一步就取不到。
   */
  private enqueueBody(requestId: string, path: string, priority = false): void {
    if (this.bodyQueue.length > 300) return
    const item = { requestId, path }
    if (priority) this.bodyQueue.unshift(item)
    else this.bodyQueue.push(item)
    void this.drainBodies()
  }

  private async drainBodies(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      // 必须串行：并发 sendCommand 会让 CDP 会话错乱（实测报 No resource with given identifier）
      while (this.bodyQueue.length) {
        const item = this.bodyQueue.shift()!
        await this.fetchBody(item)
      }
    } finally {
      this.draining = false
    }
  }

  private async fetchBody({ requestId, path }: { requestId: string; path: string }): Promise<void> {
    try {
      const res = await this.cdp<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', {
        requestId
      })
      const buf = res.base64Encoded ? Buffer.from(res.body, 'base64') : Buffer.from(res.body, 'utf8')
      this.bodyOk++
      this.ingest(buf, path)
    } catch (err) {
      this.bodyFailures++
      const key = `${path} ← ${(err as Error).message}`
      this.bodyErrorPaths.set(key, (this.bodyErrorPaths.get(key) ?? 0) + 1)
    }
  }

  /** 取体统计（只含路径与计数，不含内容），用于诊断 */
  bodyStats(): string {
    const top = [...this.bodyErrorPaths.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, n]) => `${k} ×${n}`)
      .join('；')
    return `成功 ${this.bodyOk} / 失败 ${this.bodyFailures}${top ? `；${top}` : ''}`
  }

  private ingest(buf: Buffer, path: string): void {
    // JSON 响应：抽取用户昵称/头像（会话包里只有 uid）
    if (buf.length > 2 && buf[0] === 0x7b) {
      try {
        const added = this.collector.ingestJson(JSON.parse(buf.toString('utf8')))
        if (added > 0) {
          this.logger?.debug(`BRIDGE ${path} JSON 昵称 +${added}（累计 ${this.collector.stats().names}）`)
          this.opts.onData?.({ conversations: 0, messages: 0 })
        }
        return
      } catch {
        /* 不是合法 JSON，继续按 protobuf 处理 */
      }
    }

    const stats = this.collector.ingest(buf)
    if (!stats.conversations && !stats.messages) return
    const total = this.collector.stats()
    this.logger?.debug(
      `BRIDGE ${path} → 会话 +${stats.conversations} 消息 +${stats.messages}（累计 ${total.conversations}/${total.messages}）`
    )
    this.opts.onData?.(stats)
  }

  // ---------------- 导航 ----------------

  private async navigateUntilData(): Promise<boolean> {
    for (const route of ROUTE_CANDIDATES) {
      this.logger?.info(`BRIDGE 尝试路由 ${route}`)
      const ok = await this.load(route)
      if (!ok) {
        this.logger?.warn(`BRIDGE 路由不可用：${route}`)
        continue
      }
      const page = await this.probePage()
      this.logger?.info(
        `BRIDGE 页面已加载：visibility=${page.visibility} · 标题长度=${page.title.length} · imapi 响应 ${this.imapiSeen} 个`
      )
      if (await this.waitForData(9000)) {
        this.route = route
        return true
      }
      // 兜底：首屏可能有客户端重定向，导致 requestId 失效；重载一次再采集
      this.logger?.info(`BRIDGE 首屏未取到数据，重载重试：${route}`)
      if (await this.reloadPage() && (await this.waitForData(9000))) {
        this.route = route
        return true
      }
      this.logger?.warn(
        `BRIDGE 该路由无 IM 数据：${route} · 域名 ${this.topHosts()} · 取体 ${this.bodyStats()}`
      )
    }
    this.route = ''
    return false
  }

  private async reloadPage(): Promise<boolean> {
    const wc = this.win?.webContents
    if (!wc) return false
    try {
      const stopped = new Promise<void>((resolve) => {
        const done = (): void => {
          wc.off('did-stop-loading', done)
          resolve()
        }
        wc.once('did-stop-loading', done)
        setTimeout(done, 20_000)
      })
      wc.reload()
      await stopped
      return true
    } catch {
      return false
    }
  }

  /** 读取页面的可见性与标题长度（不读正文，避免日志泄露内容） */
  private async probePage(): Promise<{ visibility: string; title: string }> {
    const wc = this.win?.webContents
    if (!wc) return { visibility: 'unknown', title: '' }
    try {
      const info = (await withTimeout(
        wc.executeJavaScript('({v: document.visibilityState, t: document.title || ""})'),
        5000,
        '页面探测超时'
      )) as { v?: string; t?: string }
      return { visibility: info?.v ?? 'unknown', title: info?.t ?? '' }
    } catch {
      return { visibility: 'unknown', title: '' }
    }
  }

  private topHosts(): string {
    return [...this.hosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([h, n]) => `${h}(${n})`)
      .join(' ')
  }

  private async load(url: string): Promise<boolean> {
    const win = this.win
    if (!win || win.isDestroyed()) return false
    try {
      await withTimeout(win.loadURL(url), 20_000, '导航超时')
      return true
    } catch (err) {
      this.logger?.debug(`BRIDGE 导航失败 ${url}：${(err as Error).message}`)
      return false
    }
  }

  private async waitForData(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const s = this.collector.stats()
      if (s.conversations > 0 || s.messages > 0) return true
      await delay(500)
    }
    return false
  }
}

function headerOf(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return ''
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? headers[key] : ''
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 只看请求体的参数名/结构，不输出任何值 */
function bodyShape(body: string): string[] {
  const t = body.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t) as unknown
      if (Array.isArray(parsed)) {
        const first = parsed[0]
        return [`json-array(${parsed.length})`, ...(first && typeof first === 'object' ? Object.keys(first) : [])]
      }
      return ['json', ...Object.keys(parsed as Record<string, unknown>)]
    } catch {
      return ['json-unparsed']
    }
  }
  const names = t
    .split('&')
    .map((kv) => kv.split('=')[0])
    .slice(0, 12)

  // 进一步看值是什么形态：JSON 数组 / 逗号串 / 其他（只报类型，不报内容）
  const firstPair = t.split('&')[0] ?? ''
  const eq = firstPair.indexOf('=')
  const value = eq >= 0 ? firstPair.slice(eq + 1) : ''
  let shape = 'unknown'
  try {
    const decoded = decodeURIComponent(value)
    if (decoded.trim().startsWith('[')) {
      const arr = JSON.parse(decoded) as unknown
      if (Array.isArray(arr)) {
        const first = arr[0] as unknown
        if (typeof first === 'string') shape = `json-strings(${arr.length})`
        else if (first && typeof first === 'object')
          shape = `json-objects(${arr.length}):${Object.keys(first).join(',')}`
        else shape = `json-other(${arr.length})`
      }
    } else if (/^[A-Za-z0-9_,%-]+$/.test(decoded)) {
      shape = `plain(${decoded.split(',').length}段)`
    }
  } catch {
    shape = 'decode-failed'
  }
  return [...names, `value=${shape}`]
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 给可能永不返回的 CDP/导航调用加硬超时，避免整条链路静默卡死 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
