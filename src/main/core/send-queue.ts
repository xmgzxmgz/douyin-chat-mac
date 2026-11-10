import type { Message, SendMessageInput } from '@shared/types'
import { AppError, isRetryable } from './errors'

export interface SendTask {
  clientId: string
  input: SendMessageInput
  attempts: number
}

export interface SendQueueDeps {
  send: (input: SendMessageInput, clientId: string) => Promise<Message>
  onAttempt?: (task: SendTask) => void
  onSuccess?: (clientId: string, message: Message) => void
  onFailure?: (clientId: string, error: AppError, attempts: number) => void
  maxAttempts?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  jitter?: () => number
}

/**
 * 串行发送队列：保证同一账号内消息按用户点击顺序投递，
 * 失败按指数退避重试，仅对可重试错误（网络/5xx/限流）重试。
 */
export class SendQueue {
  private readonly deps: SendQueueDeps
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly jitter: () => number
  private queue: SendTask[] = []
  private readonly tasks = new Map<string, SendTask>()
  private running = false
  private stopped = false

  constructor(deps: SendQueueDeps) {
    this.deps = deps
    this.maxAttempts = deps.maxAttempts ?? 3
    this.baseDelayMs = deps.baseDelayMs ?? 400
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.jitter = deps.jitter ?? (() => Math.floor(Math.random() * 120))
  }

  get size(): number {
    return this.queue.length
  }

  pendingClientIds(): string[] {
    return [...this.tasks.keys()]
  }

  enqueue(input: SendMessageInput, clientId: string): void {
    const task: SendTask = { clientId, input, attempts: 0 }
    this.tasks.set(clientId, task)
    this.queue.push(task)
    void this.drain()
  }

  /** 手动重试失败消息（复用原 clientId，服务端可据此去重） */
  retry(clientId: string, input?: SendMessageInput): boolean {
    const existing = this.tasks.get(clientId)
    const task = existing ?? (input ? { clientId, input, attempts: 0 } : null)
    if (!task) return false
    task.attempts = 0
    this.tasks.set(clientId, task)
    this.queue.push(task)
    void this.drain()
    return true
  }

  stop(): void {
    this.stopped = true
    this.queue = []
    this.tasks.clear()
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      while (this.queue.length && !this.stopped) {
        const task = this.queue.shift()!
        await this.runTask(task)
      }
    } finally {
      this.running = false
    }
  }

  private async runTask(task: SendTask): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.stopped) return
      task.attempts = attempt
      this.deps.onAttempt?.(task)
      try {
        const message = await this.deps.send(task.input, task.clientId)
        this.tasks.delete(task.clientId)
        this.deps.onSuccess?.(task.clientId, message)
        return
      } catch (err) {
        const error = AppError.from(err)
        if (!isRetryable(error) || attempt >= this.maxAttempts) {
          this.tasks.delete(task.clientId)
          this.deps.onFailure?.(task.clientId, error, attempt)
          return
        }
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1) + this.jitter())
      }
    }
  }
}
