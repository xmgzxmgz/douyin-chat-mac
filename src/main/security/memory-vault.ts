import type { CredentialVault } from '../core/chat-service'
import type { Credentials } from '../adapters/types'

/**
 * 内存凭据实现：供单元/集成测试与无 Electron 环境使用。
 * 生产环境请使用 security/vault.ts 中的系统钥匙串实现。
 */
export class MemoryVault implements CredentialVault {
  private readonly map = new Map<string, Credentials>()

  async save(accountId: string, credentials: Credentials): Promise<void> {
    this.map.set(accountId, credentials)
  }

  async load(accountId: string): Promise<Credentials | null> {
    return this.map.get(accountId) ?? null
  }

  async clear(accountId: string): Promise<void> {
    this.map.delete(accountId)
  }
}
