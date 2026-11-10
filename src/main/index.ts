import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Tray } from 'electron'
import { writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { AdapterMode } from '@shared/types'
import { MockAdapter } from './adapters/mock/mock-adapter'
import { MockServer } from './adapters/mock/mock-server'
import { DouyinWebAdapter } from './adapters/douyin/douyin-adapter'
import { DouyinPageAdapter } from './adapters/douyin/page-adapter'
import { ChatService } from './core/chat-service'
import { getPeekWindow } from './peek'
import { registerIpc } from './ipc'
import { DesktopNotifier } from './notification'
import { Store } from './store/repository'
import { Vault } from './security/vault'
import { logger } from './logging/logger'
import { createMainWindow, showMainWindow } from './window'
import { loginInWindow } from './douyin-login'
import { sniffImRequests } from './im-sniff'

let tray: Tray | null = null
let quitting = false
let service: ChatService | null = null
let store: Store | null = null
/** 页面捕获新数据时的同步节流时间戳 */
let lastNudge = 0

const dataDir = join(app.getPath('userData'), 'data')

function buildTray(): void {
  try {
    buildTrayInner()
  } catch (err) {
    logger.warn(`托盘不可用（已跳过）：${(err as Error).message}`)
  }
}

function buildTrayInner(): void {
  const size = 18
  const buffer = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    buffer[i * 4] = 0x55
    buffer[i * 4 + 1] = 0x2c
    buffer[i * 4 + 2] = 0xfe
    buffer[i * 4 + 3] = 0xff
  }
  const icon = nativeImage.createFromBitmap(buffer, { width: size, height: size })
  tray = new Tray(icon)
  tray.setToolTip('抖音桌面聊天')
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: '立即同步',
      click: () => {
        void service?.syncNow().catch((err) => logger.warn(`手动同步失败：${(err as Error).message}`))
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => showMainWindow())
}

function bootstrapService(): ChatService {
  store = new Store(dataDir)
  const settings = store.getSettings()
  // Mock 后端在进程内单例，保证切换适配器/重新登录时数据连续
  const mockServer = new MockServer({ latencyMs: 90, jitterMs: 60, autoReply: true })

  const svc = new ChatService({
    store,
    vault: new Vault(),
    notifier: new DesktopNotifier((conversationId) => {
      showMainWindow()
      service?.emit({ type: 'ui:open-conversation', payload: { conversationId } })
    }),
    logger,
    createAdapter: (mode: AdapterMode) => {
      if (mode === 'douyin-web') {
        // 页面自己发请求，客户端只解码；捕获到新数据时立刻同步一次（节流）
        return new DouyinPageAdapter({
          logger,
          onData: () => {
            const now = Date.now()
            if (now - lastNudge < 1200) return
            lastNudge = now
            void service?.syncNow().catch((err) => logger.debug(`即时同步失败：${(err as Error).message}`))
          }
        })
      }
      return new MockAdapter(mockServer)
    },
    syncIntervalMs: settings.pollIntervalMs
  })

  svc.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.event, event)
    }
  })

  registerIpc(svc, dataDir)
  return svc
}

async function bootstrap(): Promise<void> {
  const win = createMainWindow()
  service = bootstrapService()
  win.on('focus', () => service?.setFocused(true))
  win.on('blur', () => service?.setFocused(false))
  win.on('close', (event) => {
    if (quitting) return
    if (service?.getSettings().closeToTray) {
      event.preventDefault()
      win.hide()
    }
  })

  try {
    await service.init()
  } catch (err) {
    logger.error(`初始化失败：${(err as Error).message}`)
  }

  // 开发辅助：CHAT_SNIFF_IM=1 用现有会话抓取 imapi 数据（诊断）
  if (process.env.CHAT_SNIFF_IM === '1') {
    setTimeout(() => {
      void sniffImRequests(logger)
        .catch((err) => logger.error(`桥接诊断异常：${(err as Error).message}`))
        .finally(() => {
          quitting = true
          app.quit()
        })
    }, 1500)
    return
  }

  // 开发辅助：CHAT_AUTO_LOGIN=1 直接弹出应用内登录窗口（登录仍需用户扫码）
  if (process.env.CHAT_AUTO_LOGIN === '1' && service.getSession().status === 'anonymous') {
    setTimeout(() => {
      void (async () => {
        try {
          service!.updateSettings({ mode: 'douyin-web' })
          const captured = await loginInWindow(win)
          logger.info(`登录窗口 localStorage 键：${captured.storageKeys.join(', ') || '（空）'}`)
          await service!.loginWithCookie({ cookie: captured.cookie, userAgent: captured.userAgent })
          logger.info('应用内登录成功')
        } catch (err) {
          logger.warn(`应用内登录未完成：${(err as Error).message}`)
        }
      })()
    }, 700)
  }

  // 自动化验收：CHAT_DEMO=1 使用演示账号登录；CHAT_SCREENSHOT=<path> 截图后退出
  if (process.env.CHAT_DEMO === '1') {
    try {
      await service.loginWithCookie({ cookie: 'sessionid=screenshot_demo; ttwid=demo' })
    } catch (err) {
      logger.warn(`自动演示登录失败：${(err as Error).message}`)
    }
  }
  const shotPath = process.env.CHAT_SCREENSHOT
  if (shotPath) {
    const takeShot = (): void => {
      setTimeout(async () => {
        try {
          const view = process.env.CHAT_VIEW
          if (view) {
            const index = view === 'friends' ? 1 : view === 'settings' ? 2 : 0
            await win.webContents.executeJavaScript(
              `document.querySelectorAll('.rail-btn')[${index}]?.click(); true`
            )
            await new Promise((r) => setTimeout(r, 400))
          }
          if (process.env.CHAT_LOGIN_REAL === '1') {
            await win.webContents.executeJavaScript(`
              (() => {
                const segs = [...document.querySelectorAll('.login-mode .seg')];
                segs[1]?.click();
                const tabs = [...document.querySelectorAll('.tabs .tab')];
                tabs[1]?.click();
                return true;
              })()
            `)
            await new Promise((r) => setTimeout(r, 500))
          }
          if (process.env.CHAT_SEND) {
            const payload = JSON.stringify(process.env.CHAT_SEND)
            const filled = await win.webContents.executeJavaScript(`
              (() => {
                const ta = document.querySelector('.composer-input');
                if (!ta) return false;
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                setter.call(ta, ${payload});
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              })()
            `)
            if (filled) {
              // 等 React 完成一次渲染（发送按钮在非空时才可用）
              await new Promise((r) => setTimeout(r, 250))
              await win.webContents.executeJavaScript(`document.querySelector('.send-btn')?.click(); true`)
              await new Promise((r) => setTimeout(r, 1400))
            }
          }
          if (process.env.CHAT_PROBE_HISTORY === '1') {
            const out = await win.webContents.executeJavaScript(`
              (async () => {
                const list = await window.desktop.conversations.list();
                if (!list.ok || !list.data.length) return { ok: false, reason: 'no-conversations' };
                const first = list.data[0];
                const h = await window.desktop.messages.history({ conversationId: first.id, limit: 40 });
                return {
                  ok: true,
                  convs: list.data.length,
                  idLen: first.id.length,
                  title: first.title ? 'y' : 'n',
                  historyOk: h.ok,
                  count: h.ok ? h.data.length : -1,
                  error: h.ok ? null : h.error.message
                };
              })()
            `)
            logger.info(`PROBE 历史消息：${JSON.stringify(out)}`)
          }
          if (process.env.CHAT_PEEK === '1') {
            const probe = await win.webContents.executeJavaScript(
              `(() => {
                 const cards = document.querySelectorAll('.bubble-card');
                 const first = document.querySelector('.bubble-card.clickable');
                 if (!first) return { cards: cards.length, clicked: false };
                 first.click();
                 return { cards: cards.length, clicked: true };
               })()`
            )
            await new Promise((r) => setTimeout(r, 1200))
            const state = await win.webContents.executeJavaScript(
              `(() => {
                 const p = document.querySelector('.peek');
                 const w = document.querySelector('webview');
                 return {
                   peek: !!p,
                   rect: p ? JSON.stringify(p.getBoundingClientRect()) : null,
                   webview: !!w,
                   hasFrame: !!document.querySelector('.peek-web'),
                   children: document.body.innerText.slice(0, 0)
                 };
               })()`
            )
            logger.info(`PEEK 诊断：${JSON.stringify(probe)} → ${JSON.stringify(state)}`)
            await new Promise((r) => setTimeout(r, 6000))
          }
          // 原生子视图（WebContentsView）不在渲染层，capturePage 抓不到；
          // 用 macOS 的窗口截图把整窗一起拍下来
          if (process.env.CHAT_SCREENSHOT_NATIVE === '1' && process.platform === 'darwin') {
            const out = process.env.CHAT_SCREENSHOT
            if (out) {
              const shot = (target: BrowserWindow, path: string): Promise<void> =>
                new Promise<void>((resolve) => {
                  const wid = target.getMediaSourceId().split(':')[1]
                  execFile('screencapture', ['-l', wid, '-x', path], () => resolve())
                })
              win.moveTop()
              await shot(win, out)
              // 预览窗是独立窗口，单独拍一张
              const peekWin = getPeekWindow()
              if (peekWin) await shot(peekWin, out.replace(/\.png$/, '-peek.png'))
              logger.info(`已保存截图：${out}${peekWin ? '（含预览窗）' : ''}`)
            }
            setTimeout(() => app.quit(), 600)
            return
          }
          const image = await win.webContents.capturePage()
          writeFileSync(shotPath, image.toPNG())
          logger.info(`已保存界面截图：${shotPath}`)
        } catch (err) {
          logger.error(`截图失败：${(err as Error).message}`)
        } finally {
          quitting = true
          app.quit()
        }
      }, Number(process.env.CHAT_SCREENSHOT_DELAY ?? 2200))
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', takeShot)
    else takeShot()
  }

  const settings = service.getSettings()
  app.setLoginItemSettings({ openAtLogin: settings.autoLaunch })
  buildTray()

  const registered = globalShortcut.register('CommandOrControl+Shift+D', () => showMainWindow())
  if (!registered) logger.warn('全局快捷键 Cmd+Shift+D 注册失败（可能被占用）')

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' }
        ]
      },
      { role: 'windowMenu' }
    ])
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else showMainWindow()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  // 开发/截图用：CHAT_USER_DATA=<dir> 指定独立数据目录，避免演示截图混入真实数据
if (process.env.CHAT_USER_DATA) {
  app.setPath('userData', process.env.CHAT_USER_DATA)
}

if (process.platform === 'win32') app.setAppUserModelId('com.local.douyinchat')

app.whenReady().then(bootstrap).catch((err) => {
    logger.error(`启动失败：${(err as Error).message}`)
  })

  app.on('window-all-closed', () => {
    // 常驻菜单栏：除非显式退出，否则不退出应用
    if (process.platform !== 'darwin' && quitting) app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    service?.dispose()
    store?.dispose()
    tray?.destroy()
    tray = null
  })
}
