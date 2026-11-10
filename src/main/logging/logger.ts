import log from 'electron-log/main'
import type { Logger } from '../core/notifier'

log.initialize({ preload: true })
log.transports.file.level = 'info'
log.transports.console.level = 'info'
log.transports.file.maxSize = 5 * 1024 * 1024

const fmt = (meta?: unknown): unknown[] => (meta === undefined ? [] : [meta])

export const logger: Logger = {
  info: (message, meta) => log.info(message, ...fmt(meta)),
  warn: (message, meta) => log.warn(message, ...fmt(meta)),
  error: (message, meta) => log.error(message, ...fmt(meta)),
  debug: (message, meta) => log.debug(message, ...fmt(meta))
}

export const logFilePath = (): string => {
  try {
    return log.transports.file.getFile().path
  } catch {
    return ''
  }
}
