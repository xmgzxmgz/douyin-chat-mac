export interface NotificationRequest {
  title: string
  body: string
  conversationId: string
  silent?: boolean
}

export interface Notifier {
  notify(request: NotificationRequest): void
  setBadge(count: number): void
}

export class NullNotifier implements Notifier {
  notify(): void {
    /* noop */
  }
  setBadge(): void {
    /* noop */
  }
}

export class MemoryNotifier implements Notifier {
  readonly sent: NotificationRequest[] = []
  badge = 0

  notify(request: NotificationRequest): void {
    this.sent.push(request)
  }

  setBadge(count: number): void {
    this.badge = count
  }

  reset(): void {
    this.sent.length = 0
    this.badge = 0
  }
}

export interface Logger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
  debug(message: string, meta?: unknown): void
}

export const consoleLogger: Logger = {
  info: (m, meta) => console.log(`[info] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[warn] ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`[error] ${m}`, meta ?? ''),
  debug: (m, meta) => {
    if (process.env.DEBUG_CHAT) console.debug(`[debug] ${m}`, meta ?? '')
  }
}
