import { BrowserWindow, session } from 'electron'
import { AppError } from './core/errors'

const PARTITION = 'persist:douyin-im'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export interface CapturedSession {
  cookie: string
  userAgent: string
  /** 页面 localStorage 的键名（仅键名，用于定位 IM token 来源） */
  storageKeys: string[]
}

/**
 * 在应用内打开抖音网页，让用户自己完成扫码登录。
 * 登录成功后从**本应用自己的 session 分区**读取 Cookie（不触碰用户的浏览器配置），
 * 交给主进程的 IM 适配器使用。
 */
export async function loginInWindow(parent: BrowserWindow | null): Promise<CapturedSession> {
  const ses = session.fromPartition(PARTITION)
  const win = new BrowserWindow({
    width: 1040,
    height: 800,
    parent: parent ?? undefined,
    title: '登录抖音（登录后自动关闭）',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })
  win.webContents.setUserAgent(UA)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  try {
    await win.loadURL('https://www.douyin.com/')
  } catch (err) {
    win.destroy()
    throw new AppError('NETWORK', `打开抖音登录页失败：${(err as Error).message}`)
  }

  return new Promise<CapturedSession>((resolve, reject) => {
    let settled = false
    let polling = false

    const cleanup = (): void => {
      clearInterval(timer)
      clearTimeout(timeout)
      if (!win.isDestroyed()) win.destroy()
    }

    const succeed = async (): Promise<void> => {
      let storageKeys: string[] = []
      try {
        storageKeys = (await win.webContents.executeJavaScript(
          'Object.keys(window.localStorage).slice(0, 60)'
        )) as string[]
      } catch {
        storageKeys = []
      }
      settled = true
      cleanup()
      const cookies = (await ses.cookies.get({})).filter((c) => c.domain?.endsWith('douyin.com'))
      const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
      if (!cookies.some((c) => c.name === 'sessionid')) {
        reject(new AppError('AUTH_REQUIRED', '未捕获到 sessionid，请确认已完成登录'))
        return
      }
      resolve({ cookie: header, userAgent: UA, storageKeys })
    }

    const check = async (): Promise<void> => {
      if (settled || polling) return
      polling = true
      try {
        const list = await ses.cookies.get({ name: 'sessionid' })
        const hit = list.find((c) => c.domain?.endsWith('douyin.com') && c.value.length > 20)
        if (hit) {
          // 等页面把其余 Cookie 写完
          setTimeout(() => void succeed(), 1200)
        }
      } finally {
        polling = false
      }
    }

    const timer = setInterval(() => void check(), 1200)
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new AppError('AUTH_REQUIRED', '登录超时（5 分钟），请重试'))
    }, 5 * 60 * 1000)

    win.on('closed', () => {
      if (settled) return
      settled = true
      clearInterval(timer)
      clearTimeout(timeout)
      reject(new AppError('AUTH_REQUIRED', '登录窗口已关闭，未完成登录'))
    })
  })
}
