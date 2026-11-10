import { BrowserWindow, screen, shell } from 'electron'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

let peekWindow: BrowserWindow | null = null

/** 把桌面链接换成 iesdouyin 的分享页，渲染更接近手机抖音 */
function toMobileUrl(url: string): string {
  const video = url.match(/douyin\.com\/(?:video|discover)\/(\d{6,})/)
  if (video) return `https://www.iesdouyin.com/share/video/${video[1]}/`
  const note = url.match(/douyin\.com\/note\/(\d{6,})/)
  if (note) return `https://www.iesdouyin.com/share/note/${note[1]}/`
  return url
}

/**
 * 右侧「手机预览」用一个独立的无边框窗口实现。
 *
 * 试过两条更「内嵌」的路都不行：
 *  - 渲染进程里的 <webview>：加载跨站页面会把渲染进程带崩，界面直接回到登录页；
 *  - 主进程 WebContentsView 覆盖在主窗口上：同样会让主界面状态错乱。
 * 独立窗口最稳，崩了也只影响这一块，关掉即恢复。
 */
export function openPeek(parent: BrowserWindow, rawUrl: string): void {
  console.log(`[peek] open url=${rawUrl.slice(0, 60)}`)
  if (!/^https?:\/\//.test(rawUrl)) {
    console.log('[peek] 非法链接，忽略')
    return
  }
  const url = toMobileUrl(rawUrl)

  if (peekWindow && !peekWindow.isDestroyed()) {
    void peekWindow.loadURL(url)
    peekWindow.show()
    peekWindow.focus()
    return
  }

  const anchor = parent.getBounds()
  const display = screen.getDisplayMatching(anchor).workArea
  const width = 392
  const height = Math.min(Math.max(600, anchor.height), display.height - 40)
  // 优先贴在主窗口右侧，右侧放不下就贴左侧
  let x = anchor.x + anchor.width + 12
  if (x + width > display.x + display.width) x = Math.max(display.x + 12, anchor.x - width - 12)
  const y = Math.max(display.y + 12, anchor.y)

  peekWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    roundedCorners: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#111318',
    title: '抖音预览',
    webPreferences: {
      partition: 'persist:douyin-im',
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  peekWindow.setWindowButtonVisibility?.(false)
  peekWindow.webContents.setUserAgent(IPHONE_UA)
  peekWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  peekWindow.on('closed', () => {
    peekWindow = null
  })

  // 无边框窗口没有关闭按钮：注入一条可拖动区域 + 关闭键，否则用户关不掉
  peekWindow.webContents.on('did-finish-load', () => {
    const script = `
      (() => {
        if (document.getElementById('dy-peek-close')) return;
        const style = document.createElement('style');
        style.textContent = [
          '#dy-peek-bar{position:fixed;top:0;left:0;right:0;height:32px;z-index:2147483647;',
          '-webkit-app-region:drag;background:linear-gradient(180deg,rgba(0,0,0,.45),rgba(0,0,0,0));}',
          '#dy-peek-close{position:fixed;top:8px;right:8px;width:26px;height:26px;border-radius:50%;',
          'background:rgba(0,0,0,.55);color:#fff;border:0;font-size:13px;line-height:26px;text-align:center;',
          'cursor:pointer;-webkit-app-region:no-drag;z-index:2147483647;font-family:system-ui}'
        ].join('');
        document.head.appendChild(style);
        const bar = document.createElement('div');
        bar.id = 'dy-peek-bar';
        const btn = document.createElement('button');
        btn.id = 'dy-peek-close';
        btn.textContent = '✕';
        btn.onclick = () => window.close();
        document.body.appendChild(bar);
        document.body.appendChild(btn);
      })()
    `
    void peekWindow?.webContents.executeJavaScript(script).catch(() => undefined)
  })
  void peekWindow.loadURL(url)
}

/** 当前预览窗（可能为 null）；截图/调试用 */
export function getPeekWindow(): BrowserWindow | null {
  return peekWindow && !peekWindow.isDestroyed() ? peekWindow : null
}

export function closePeek(): void {
  if (peekWindow && !peekWindow.isDestroyed()) peekWindow.close()
  peekWindow = null
}
