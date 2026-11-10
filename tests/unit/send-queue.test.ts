import { describe, expect, it } from 'vitest'
import type { Message, SendMessageInput } from '../../src/shared/types'
import { AppError } from '../../src/main/core/errors'
import { SendQueue } from '../../src/main/core/send-queue'

function makeMessage(clientId: string, text: string): Message {
  return {
    id: clientId,
    clientId,
    conversationId: 'conv_1',
    accountId: 'acc_1',
    senderId: 'me',
    senderName: '我',
    type: 'text',
    content: { text },
    createdAt: Date.now(),
    status: 'sent',
    isSelf: true
  }
}

const input = (text: string): SendMessageInput => ({ conversationId: 'conv_1', type: 'text', content: { text } })
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('SendQueue · 串行与重试', () => {
  it('按入队顺序串行投递（即使前一条更慢）', async () => {
    const order: string[] = []
    const settled = new Promise<void>((resolve, reject) => {
      const queue = new SendQueue({
        send: async (i, clientId) => {
          await delay(i.content.text === '1' ? 18 : 2)
          order.push(i.content.text ?? '')
          return makeMessage(clientId, i.content.text ?? '')
        },
        onSuccess: () => {
          if (order.length === 3) resolve()
        },
        onFailure: (_id, err) => reject(err),
        sleep: async () => {},
        jitter: () => 0
      })
      queue.enqueue(input('1'), 'c1')
      queue.enqueue(input('2'), 'c2')
      queue.enqueue(input('3'), 'c3')
    })
    await settled
    expect(order).toEqual(['1', '2', '3'])
  })

  it('网络类错误自动重试后成功，attempts 递增', async () => {
    let calls = 0
    const attempts: number[] = []
    const settled = new Promise<void>((resolve, reject) => {
      const queue = new SendQueue({
        send: async (_i, clientId) => {
          calls += 1
          if (calls === 1) throw new AppError('NETWORK', '断网')
          return makeMessage(clientId, 'ok')
        },
        onAttempt: (t) => attempts.push(t.attempts),
        onSuccess: () => resolve(),
        onFailure: (_id, err) => reject(err),
        sleep: async () => {},
        jitter: () => 0,
        maxAttempts: 3
      })
      queue.enqueue(input('hi'), 'c1')
    })
    await settled
    expect(calls).toBe(2)
    expect(attempts).toEqual([1, 2])
  })

  it('不可重试错误立即失败，不消耗重试次数', async () => {
    let calls = 0
    const failures: Array<{ code: string; attempts: number }> = []
    const settled = new Promise<void>((resolve) => {
      const queue = new SendQueue({
        send: async () => {
          calls += 1
          throw new AppError('VALIDATION', '内容为空')
        },
        onFailure: (_id, err, attempts) => {
          failures.push({ code: err.code, attempts })
          resolve()
        },
        sleep: async () => {},
        maxAttempts: 3
      })
      queue.enqueue(input(''), 'c1')
    })
    await settled
    expect(calls).toBe(1)
    expect(failures).toEqual([{ code: 'VALIDATION', attempts: 1 }])
  })

  it('达到最大次数后标记失败', async () => {
    let calls = 0
    const failures: number[] = []
    const settled = new Promise<void>((resolve) => {
      const queue = new SendQueue({
        send: async () => {
          calls += 1
          throw new AppError('NETWORK', '断网')
        },
        onFailure: (_id, _e, attempts) => {
          failures.push(attempts)
          resolve()
        },
        sleep: async () => {},
        maxAttempts: 3,
        jitter: () => 0
      })
      queue.enqueue(input('x'), 'c1')
    })
    await settled
    expect(calls).toBe(3)
    expect(failures).toEqual([3])
  })

  it('手动重试可复用原 clientId 与消息体', async () => {
    let calls = 0
    let queue!: SendQueue
    const settled = new Promise<void>((resolve) => {
      queue = new SendQueue({
        send: async (_i, clientId) => {
          calls += 1
          return makeMessage(clientId, 'retried')
        },
        onSuccess: () => resolve(),
        sleep: async () => {},
        jitter: () => 0
      })
      expect(queue.retry('c9', input('again'))).toBe(true)
    })
    await settled
    expect(calls).toBe(1)
    expect(queue.size).toBe(0)
  })

  it('不存在的任务无法重试', () => {
    const queue = new SendQueue({ send: async () => makeMessage('x', 'x') })
    expect(queue.retry('missing')).toBe(false)
  })
})
