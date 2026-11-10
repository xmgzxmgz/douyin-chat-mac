import type { SyncStatus } from '@shared/types'
import { AppError } from './errors'
import type { PullResult } from '../adapters/types'

export interface SyncEngineDeps {
  pull: (cursor: number) => Promise<PullResult>
  getCursor: () => number
  setCursor: (cursor: number) => void
  onPull: (result: PullResult) => void | Promise<void>
  onStatus: (status: SyncStatus) => void
  onAuthExpired?: (error: AppError) => void
  intervalMs?: number
  now?: () => number
}

/**
 * 轮询式增量同步引擎。
 * 采用递归 setTimeout（而非 setInterval）以便：
 *   1. 上一轮未结束时不会堆积请求；
 *   2. 失败后按失败次数线性退避，避免持续打爆接口；
 *   3. 登录态失效时立即停机并上抛，由上层引导重新登录。
 */
export class SyncEngine {
  private readonly deps: SyncEngineDeps
  private intervalMs: number
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private inflight: Promise<SyncStatus> | null = null
  private failures = 0
  private lastSyncAt: number | null = null

  constructor(deps: SyncEngineDeps) {
    this.deps = deps
    this.intervalMs = deps.intervalMs ?? 4000
    this.now = deps.now ?? (() => Date.now())
  }

  get isRunning(): boolean {
    return !this.stopped
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.failures = 0
    this.deps.onStatus({ phase: 'connecting', lastSyncAt: this.lastSyncAt })
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.deps.onStatus({ phase: 'idle', lastSyncAt: this.lastSyncAt })
  }

  setIntervalMs(ms: number): void {
    if (ms > 0) this.intervalMs = ms
  }

  /** 立即同步；若已有同步在途，复用同一 Promise（调用方不会被"假成功"骗到） */
  syncNow(): Promise<SyncStatus> {
    if (this.inflight) return this.inflight
    this.inflight = this.doSync().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doSync(): Promise<SyncStatus> {
    const startedAt = this.now()
    try {
      const cursor = this.deps.getCursor()
      const result = await this.deps.pull(cursor)
      if (result.messages.length || result.conversations.length) {
        await this.deps.onPull(result)
      }
      if (result.cursor > cursor) this.deps.setCursor(result.cursor)
      this.lastSyncAt = this.now()
      this.failures = 0
      const status: SyncStatus = {
        phase: 'syncing',
        lastSyncAt: this.lastSyncAt,
        latencyMs: this.now() - startedAt
      }
      this.deps.onStatus(status)
      return status
    } catch (err) {
      const error = AppError.from(err)
      this.failures += 1
      if (error.code === 'AUTH_EXPIRED' || error.code === 'AUTH_REQUIRED') {
        this.stop()
        this.deps.onAuthExpired?.(error)
        const status: SyncStatus = { phase: 'error', lastSyncAt: this.lastSyncAt, error: error.message }
        this.deps.onStatus(status)
        return status
      }
      const status: SyncStatus = { phase: 'offline', lastSyncAt: this.lastSyncAt, error: error.message }
      this.deps.onStatus(status)
      return status
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return
    await this.syncNow()
    if (this.stopped) return
    const backoff = Math.min(this.failures, 4)
    const delay = this.intervalMs * Math.max(1, backoff)
    this.timer = setTimeout(() => void this.loop(), delay)
    this.timer.unref?.()
  }
}
