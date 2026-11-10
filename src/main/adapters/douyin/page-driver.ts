import type { WebContents } from 'electron'
import type { Logger } from '../../core/notifier'

/**
 * 页面驱动层：用「页面自己」完成发送，而不是伪造请求。
 *
 * 为什么这样做：imapi 的 /v1/message/send 除了 protobuf 体，还要求一个由页面运行时
 * 生成的 identity_security_token，且服务端对重放极其敏感（实测直接返回 KICK 踢线）。
 * 与其逆向签名，不如让页面按人的操作走一遍：点开会话 → 聚焦输入框 → 输入文字 → 发送。
 * 这样 Cookie、签名、风控指纹全部由官方前端自己产生，客户端只负责「代点」。
 *
 * 选择器全部用 data-e2e（前端自己的测试标识），不依赖 CSS Module 的哈希类名：
 *   会话项  [data-e2e="conversation-item"]
 *   消息项  [data-e2e="msg-item-content"]
 *   输入区  [data-e2e="msg-input"] 里的 contenteditable
 */

const CHAT_URL = 'https://www.douyin.com/chat'

export interface DriveConversation {
  /** 在全部 conversation-item 里的下标（点击时要按这个取元素） */
  index: number
  text: string
}

export interface ComposerState {
  found: boolean
  placeholder: string
  text: string
  rect: [number, number, number, number] | null
}

export interface SendButtonState {
  found: boolean
  disabled: boolean
  point: [number, number] | null
  label: string
  /** 输入区附近其它按钮，仅用于人工核对选择器 */
  candidates?: Array<{ label: string; cls: string; e2e: string }>
}

export interface ClickPoint {
  x: number
  y: number
}

/** CDP 发送函数（由 ImWebBridge 注入，复用已附加的调试通道） */
export type CdpSend = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

export function normalizeText(input: string): string {
  return (input ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 抖音的富文本编辑器在「空」状态下会留一个零宽字符（\u200b）。
 * 判断输入框是否为空必须把它一起剥掉，否则永远等不到清空。
 */
export function visibleText(input: string): string {
  return (input ?? '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从会话列表里挑出目标会话。
 * 列表项文本 = 昵称 + 最后一条预览 + 时间，所以先要求「昵称后面是空格或结束」，
 * 否则「张三」会命中「张三丰」。只有完全没有边界命中时，才退化为包含匹配；
 * 命中多个时取文本最短的那个。
 */
export function pickConversation(
  list: DriveConversation[],
  title: string
): DriveConversation | null {
  const want = normalizeText(title)
  if (!want) return null
  const normalized = list.map((c) => ({ ...c, norm: normalizeText(c.text) }))
  const exact = normalized.filter((c) => c.norm === want)
  const starts = normalized.filter((c) => c.norm.startsWith(`${want} `))
  const contains = normalized.filter((c) => c.norm.includes(want))
  const pool = exact.length ? exact : starts.length ? starts : contains
  if (!pool.length) return null
  return pool.sort((a, b) => a.norm.length - b.norm.length)[0]
}

export class PageDriver {
  constructor(
    private readonly wc: WebContents,
    private readonly cdp: CdpSend,
    private readonly logger?: Logger
  ) {}

  private js<T>(script: string): Promise<T> {
    return this.wc.executeJavaScript(script) as Promise<T>
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  async currentPath(): Promise<string> {
    if (this.wc.isDestroyed()) return ''
    return this.js<string>('location.pathname').catch(() => '')
  }

  /** 打开私信页并等会话列表出现（页面已在 /chat 就不重复导航） */
  async openChatPage(timeoutMs = 30_000): Promise<boolean> {
    if (this.wc.isDestroyed()) return false
    const path = await this.currentPath()
    if (path !== '/chat') {
      // 说明：这里必须用页面自身的路由，直接 loadURL 会把 SPA 状态清掉重来
      await this.wc.loadURL(CHAT_URL).catch(() => undefined)
    }
    return this.waitForList(timeoutMs)
  }

  async waitForList(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const n = await this.js<number>(
        `document.querySelectorAll('[data-e2e="conversation-item"]').length`
      ).catch(() => 0)
      if (n > 0) return true
      await this.delay(500)
    }
    return false
  }

  async listConversations(limit = 60): Promise<DriveConversation[]> {
    return this.js<DriveConversation[]>(`(() => {
      const out = [];
      const items = [...document.querySelectorAll('[data-e2e="conversation-item"]')];
      items.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.height < 24 || r.width < 40) return;
        out.push({ index: i, text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 100) });
      });
      return out.slice(0, ${limit});
    })()`)
  }

  private async clickAt(x: number, y: number): Promise<void> {
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    })
    await this.cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    })
  }

  /**
   * 点开会话。返回 matched 是列表项原文，便于人工确认点对了人。
   */
  async openConversation(
    title: string
  ): Promise<{ ok: boolean; matched?: string; reason?: string }> {
    const list = await this.listConversations()
    if (!list.length) return { ok: false, reason: '会话列表为空（页面可能还在加载）' }
    const target = pickConversation(list, title)
    if (!target) return { ok: false, reason: `列表里没有找到「${normalizeText(title)}」` }

    const point = await this.js<ClickPoint | null>(`(() => {
      const el = document.querySelectorAll('[data-e2e="conversation-item"]')[${target.index}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + Math.min(r.width * 0.55, r.width - 16)),
        y: Math.round(r.top + r.height / 2)
      };
    })()`)
    if (!point) return { ok: false, reason: '会话项已不在页面上（列表可能刷新了）' }

    await this.clickAt(point.x, point.y)
    return { ok: true, matched: target.text }
  }

  async composer(): Promise<ComposerState> {
    return this.js<ComposerState>(`(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 8) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const eds = [...document.querySelectorAll('[data-e2e="msg-input"] [contenteditable="true"], [contenteditable="true"]')].filter(vis);
      const el = eds.find((e) => /发送消息|发消息/.test(e.getAttribute('data-placeholder') || '')) || eds[0];
      if (!el) return { found: false, placeholder: '', text: '', rect: null };
      const r = el.getBoundingClientRect();
      return {
        found: true,
        placeholder: el.getAttribute('data-placeholder') || '',
        text: (el.innerText || '').replace(/[\\u200b-\\u200d\\ufeff]/g, '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
      };
    })()`)
  }

  async waitForComposer(timeoutMs = 12_000): Promise<ComposerState> {
    const deadline = Date.now() + timeoutMs
    let last: ComposerState = { found: false, placeholder: '', text: '', rect: null }
    while (Date.now() < deadline) {
      last = await this.composer().catch(() => last)
      if (last.found) return last
      await this.delay(400)
    }
    return last
  }

  /** 点输入框正中，拿焦点 */
  async focusComposer(): Promise<boolean> {
    const state = await this.composer()
    if (!state.found || !state.rect) return false
    const [left, top, width, height] = state.rect
    await this.clickAt(Math.round(left + width / 2), Math.round(top + height / 2))
    await this.delay(120)
    return this.js<boolean>(
      `(() => { const a = document.activeElement; return !!(a && a.isContentEditable) })()`
    ).catch(() => false)
  }

  async composerText(): Promise<string> {
    const state = await this.composer()
    return state.text
  }

  /** 输入文本；优先 CDP 原生输入（会触发 beforeinput/input，富文本编辑器才认） */
  async typeText(text: string): Promise<boolean> {
    if (!text) return false
    try {
      await this.cdp('Input.insertText', { text })
    } catch {
      /* 回退到 execCommand */
    }
    await this.delay(180)
    const probe = text.slice(0, Math.min(8, text.length))
    let got = await this.composerText()
    if (got.includes(probe)) return true

    // 回退：直接让页面执行插入命令
    const ok = await this.js<boolean>(`(() => {
      const eds = [...document.querySelectorAll('[data-e2e="msg-input"] [contenteditable="true"], [contenteditable="true"]')];
      const el = eds.find((e) => /发送消息|发消息/.test(e.getAttribute('data-placeholder') || '')) || eds[0];
      if (!el) return false;
      el.focus();
      try { return document.execCommand('insertText', false, ${JSON.stringify(text)}) } catch (e) { return false }
    })()`).catch(() => false)
    await this.delay(200)
    got = await this.composerText()
    return ok || got.includes(probe)
  }

  /** 找发送按钮（有的话优先点它，比回车稳） */
  async sendButton(): Promise<SendButtonState> {
    return this.js<SendButtonState>(`(() => {
      const norm = (s) => (s || '').replace(/[\\u200b-\\u200d\\ufeff]/g, '').replace(/\\s+/g, '').trim();
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 16 || r.height < 14) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const labelOf = (el) => norm(el.innerText) || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-e2e') || '';
      const cands = [...document.querySelectorAll('button, [role="button"], [data-e2e*="send"], [class*="send"], .e2e-send-msg-btn, [class*="publishBtn"]')].filter(vis);
      const el = cands.find((e) => /^发送$/.test(labelOf(e)) && !e.disabled)
        || cands.find((e) => /发送/.test(labelOf(e)) && !e.disabled)
        || cands.find((e) => /send/i.test(e.getAttribute('data-e2e') || '') && !e.disabled);
      if (!el) return { found: false, disabled: false, point: null, label: '', candidates: [] };
      const r = el.getBoundingClientRect();
      // 顺带把输入区附近的按钮报出来，便于人工核对选择器
      const near = [...document.querySelectorAll('button, [role="button"], [class*="send"], [class*="btn"]')]
        .filter(vis)
        .filter((b) => Math.abs(b.getBoundingClientRect().top - r.top) < 80)
        .slice(0, 8)
        .map((b) => ({ label: labelOf(b).slice(0, 10), cls: String(b.className || '').slice(0, 30), e2e: b.getAttribute('data-e2e') || '' }));
      return {
        found: true,
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        point: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)],
        label: labelOf(el).slice(0, 12) || 'send',
        candidates: near
      };
    })()`)
  }

  /**
   * 提交：有发送按钮就点按钮，否则敲回车。
   * 返回实际使用的通道，便于日志核对（两者只会走一条，不会重复发送）。
   */
  async submit(): Promise<{ via: 'button' | 'enter'; ok: boolean }> {
    const btn = await this.sendButton()
    if (btn.found && !btn.disabled && btn.point) {
      await this.clickAt(btn.point[0], btn.point[1])
      return { via: 'button', ok: true }
    }
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 36
    })
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 36
    })
    return { via: 'enter', ok: true }
  }

  /**
   * 兜底：按位置点输入区最右侧的图标按钮。
   * 抖音的发送按钮是纯图标（类名是 CSS Module 哈希、无 aria-label），
   * 选择器抓不到时，用「输入行最右、20~60px 见方」这个几何特征定位。
   */
  async clickSendFallback(): Promise<boolean> {
    const point = await this.js<ClickPoint | null>(`(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 18 || r.height < 18) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const eds = [...document.querySelectorAll('[data-e2e="msg-input"] [contenteditable="true"], [contenteditable="true"]')].filter(vis);
      const ed = eds.find((e) => /发送消息|发消息/.test(e.getAttribute('data-placeholder') || '')) || eds[0];
      if (!ed) return null;
      const row = ed.closest('[data-e2e="msg-input"]') || ed.parentElement?.parentElement || ed;
      const rr = row.getBoundingClientRect();
      const cands = [...row.querySelectorAll('*')].filter(vis).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 20 && r.height >= 20 && r.width <= 64 && r.height <= 64 &&
          r.right > rr.right - 76 && r.top > rr.top - 6 && r.bottom < rr.bottom + 6;
      });
      if (!cands.length) return null;
      const el = cands[cands.length - 1];
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`).catch(() => null)
    if (!point) return false
    await this.clickAt(point.x, point.y)
    return true
  }

  /** 清空输入框（用于草稿探测后复原，避免留下半句话） */
  async clearComposer(): Promise<boolean> {
    const focused = await this.focusComposer()
    if (!focused) return false
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 0
    })
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 0
    })
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 51
    })
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 51
    })
    await this.delay(150)
    return visibleText(await this.composerText()) === ''
  }

  /** 等输入框被清空：页面发送成功的直接信号 */
  async waitForComposerEmpty(timeoutMs = 6000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const text = await this.composerText().catch(() => '')
      if (visibleText(text) === '') return true
      await this.delay(250)
    }
    return false
  }

  log(message: string): void {
    this.logger?.info(`PAGE ${message}`)
  }
}
