import type { AdapterMode } from '@shared/types'
import type { ChatAdapter } from './types'
import { MockAdapter } from './mock/mock-adapter'
import { MockServer, type MockServerOptions } from './mock/mock-server'
import { DouyinWebAdapter } from './douyin/douyin-adapter'
import { DouyinImAdapter } from './douyin/im-adapter'
import { DouyinPageAdapter } from './douyin/page-adapter'
import type { FetchLike } from './douyin/http-client'
import type { FetchLike as ImFetchLike } from './douyin/im-adapter'
import type { Logger } from '../core/notifier'
import type { Signer } from './douyin/signature'

export interface AdapterFactoryOptions {
  mockServer?: MockServer
  mockOptions?: MockServerOptions
  signer?: Signer
  fetchImpl?: FetchLike
  /** 真实 IM 适配器注入的 fetch（测试用） */
  imFetchImpl?: ImFetchLike
  /** 诊断日志 */
  logger?: Logger
  /** 页面捕获到新数据时回调 */
  onIncoming?: () => void
}

export function createAdapter(mode: AdapterMode, opts: AdapterFactoryOptions = {}): ChatAdapter {
  if (mode === 'douyin-web') {
    // 真实模式：页面传输（页面自己发请求，客户端只解码响应）
    return new DouyinPageAdapter({ logger: opts.logger, onData: opts.onIncoming })
  }
  return new MockAdapter(opts.mockServer, opts.mockOptions)
}

export { MockServer, MockAdapter, DouyinWebAdapter, DouyinImAdapter, DouyinPageAdapter }
export type { ChatAdapter, Signer, FetchLike }
