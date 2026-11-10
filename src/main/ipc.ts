import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { IPC, type Result } from '@shared/ipc'
import { AppError } from './core/errors'
import type { ChatService } from './core/chat-service'
import { closePeek, openPeek } from './peek'
import { getMainWindow } from './window'
import { loginInWindow } from './douyin-login'

function handle<T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await fn(...(args as never[]))
      return { ok: true, data } satisfies Result<T>
    } catch (err) {
      const error = AppError.from(err)
      return { ok: false, error: { code: error.code, message: error.message } } satisfies Result<never>
    }
  })
}

export function registerIpc(service: ChatService, dataDir: string): void {
  // ---- 鉴权 ----
  handle(IPC.authLoginCookie, (input: { cookie: string; userAgent?: string }) => service.loginWithCookie(input))
  handle(IPC.authLoginDouyin, async () => {
    const captured = await loginInWindow(getMainWindow())
    return service.loginWithCookie({ cookie: captured.cookie, userAgent: captured.userAgent })
  })
  handle(IPC.authLoginQr, () => service.createQrLogin())
  handle(IPC.authPollQr, (qrId: string) => service.pollQrLogin(qrId))
  handle(IPC.authCancelQr, (qrId: string) => service.cancelQrLogin(qrId))
  handle(IPC.authLogout, () => service.logout())
  handle(IPC.authSession, () => service.getSession())
  handle(IPC.authAccounts, () => service.listAccounts())
  handle(IPC.authSwitch, (accountId: string) => service.switchAccount(accountId))

  // ---- 会话 ----
  handle(IPC.convList, () => service.listConversations())
  handle(IPC.convPin, (id: string, pinned: boolean) => service.setPinned(id, pinned))
  handle(IPC.convMute, (id: string, muted: boolean) => service.setMuted(id, muted))
  handle(IPC.convRead, (id: string) => service.markRead(id))
  handle(IPC.convActive, (id: string | null) => {
    service.setActiveConversation(id)
    return true
  })
  handle(IPC.convHide, (id: string, hidden: boolean) => service.setHidden(id, hidden))
  handle(IPC.convDraft, (id: string, draft: string) => {
    service.setDraft(id, draft)
    return true
  })
  handle(IPC.convFind, (keyword: string) => service.findConversations(keyword))

  // ---- 消息 ----
  handle(IPC.msgHistory, (query: { conversationId: string; before?: number; limit?: number }) =>
    service.history(query.conversationId, query.before, query.limit)
  )
  handle(IPC.msgSend, (input: Parameters<ChatService['send']>[0]) => service.send(input))
  handle(IPC.msgRetry, (clientId: string) => service.retry(clientId))
  handle(IPC.msgRecall, (id: string) => service.recall(id))
  handle(IPC.msgDeleteLocal, (id: string) => {
    service.deleteLocal(id)
    return true
  })
  handle(IPC.msgTyping, (conversationId: string) => service.sendTyping(conversationId))

  handle(IPC.peekOpen, (url: string) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
    if (win) openPeek(win, url)
    return true
  })
  handle(IPC.peekClose, () => {
    closePeek()
    return true
  })

  // ---- 好友 ----
  handle(IPC.friendList, () => service.listFriends())
  handle(IPC.friendSearch, (keyword: string) => service.searchFriends(keyword))
  handle(IPC.friendAdd, (userId: string, remark?: string) => service.addFriend(userId, remark))
  handle(IPC.friendRemove, (id: string) => service.removeFriend(id))
  handle(IPC.friendBlock, (id: string, blocked: boolean) => service.setBlocked(id, blocked))
  handle(IPC.friendRemark, (id: string, remark: string) => service.setRemark(id, remark))

  // ---- 设置 ----
  handle(IPC.settingsGet, () => service.getSettings())
  handle(IPC.settingsUpdate, (patch: Parameters<ChatService['updateSettings']>[0]) => service.updateSettings(patch))

  // ---- 应用 ----
  handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    dataDir,
    adapter: service.getSettings().mode
  }))

  handle(IPC.appSync, () => service.syncNow())

  handle(IPC.appOpenExternal, async (url: string) => {
    if (!/^https?:\/\//.test(url)) throw new AppError('VALIDATION', '仅允许打开 http(s) 链接')
    await shell.openExternal(url)
    return true
  })

  handle(IPC.appExport, async (conversationId: string) => {
    const { filename, content } = service.exportConversation(conversationId)
    const win = getMainWindow()
    const options = {
      title: '导出聊天记录',
      defaultPath: filename,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '纯文本', extensions: ['txt'] }
      ]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { path: '' }
    await writeFile(result.filePath, content, 'utf8')
    return { path: result.filePath }
  })

  handle(IPC.appClearCache, async () => {
    await session.defaultSession.clearCache()
    return true
  })

  handle(IPC.appQuit, () => {
    app.quit()
    return true
  })
}
