export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'SERVER'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'CONFLICT'
  | 'INTERNAL'

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['NETWORK', 'SERVER', 'RATE_LIMITED'])

export class AppError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly detail?: unknown

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
    this.retryable = RETRYABLE.has(code)
  }

  static from(err: unknown): AppError {
    if (err instanceof AppError) return err
    const message = err instanceof Error ? err.message : String(err)
    return new AppError('INTERNAL', message)
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof AppError ? err.retryable : true
}
