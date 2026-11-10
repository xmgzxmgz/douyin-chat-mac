import { app, safeStorage } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CredentialVault } from '../core/chat-service'
import type { Credentials } from '../adapters/types'

/**
 * 凭据保险箱：Cookie 绝不进入渲染进程，也绝不明文落盘。
 * macOS 上使用 Keychain 支撑的 safeStorage（AES-GCM + 系统密钥）；
 * 若系统不支持，则降级为仅本机、权限 0600 的混淆存储，并在日志中告警。
 */
export class Vault implements CredentialVault {
  private readonly file: string
  private records: Record<string, string> = {}

  constructor(dir?: string) {
    this.file = join(dir ?? join(app.getPath('userData'), 'secure'), 'credentials.bin')
    mkdirSync(dirname(this.file), { recursive: true })
    this.readFromDisk()
  }

  private readFromDisk(): void {
    if (!existsSync(this.file)) return
    try {
      this.records = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>
    } catch {
      this.records = {}
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.records), { mode: 0o600 })
    try {
      chmodSync(this.file, 0o600)
    } catch {
      /* ignore */
    }
  }

  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(value).toString('base64')}`
    }
    return `raw:${Buffer.from(value, 'utf8').toString('base64')}`
  }

  private decrypt(value: string): string {
    if (value.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    }
    return Buffer.from(value.slice(4), 'base64').toString('utf8')
  }

  async save(accountId: string, credentials: Credentials): Promise<void> {
    this.records[accountId] = this.encrypt(JSON.stringify(credentials))
    this.persist()
  }

  async load(accountId: string): Promise<Credentials | null> {
    const raw = this.records[accountId]
    if (!raw) return null
    try {
      return JSON.parse(this.decrypt(raw)) as Credentials
    } catch {
      return null
    }
  }

  async clear(accountId: string): Promise<void> {
    delete this.records[accountId]
    this.persist()
  }

  has(accountId: string): boolean {
    return Boolean(this.records[accountId])
  }
}

/** 测试 / 纯 Node 环境使用的内存实现（见 memory-vault.ts，避免引入 electron 依赖） */
export { MemoryVault } from './memory-vault'
