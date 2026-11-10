import { app, Notification } from 'electron'
import type { NotificationRequest, Notifier } from './core/notifier'

/**
 * 系统通知 + Dock 角标。
 * 点击通知会聚焦窗口并跳到对应会话。
 */
export class DesktopNotifier implements Notifier {
  constructor(private readonly onClickConversation: (conversationId: string) => void) {}

  notify(request: NotificationRequest): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: request.title,
      body: request.body,
      silent: request.silent ?? false
    })
    notification.on('click', () => this.onClickConversation(request.conversationId))
    notification.show()
  }

  setBadge(count: number): void {
    if (!app.dock) return
    app.dock.setBadge(count > 0 ? String(count) : '')
  }
}
