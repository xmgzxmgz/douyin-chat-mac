import { describe, expect, it } from 'vitest'
import { normalizeText, pickConversation } from '../../src/main/adapters/douyin/page-driver'

/**
 * 会话定位是「页面驱动发送」最容易点错人的一步，单独用纯函数覆盖：
 * 列表项文本 = 昵称 + 最后一条预览 + 时间，所以只能靠前缀优先 + 最短命中的规则。
 */
describe('normalizeText', () => {
  it('折叠空白并去掉首尾空格', () => {
    expect(normalizeText('  per.fect   17 \n 18分钟前 ')).toBe('per.fect 17 18分钟前')
  })

  it('空值安全', () => {
    expect(normalizeText('')).toBe('')
  })
})

describe('pickConversation', () => {
  const list = [
    { index: 0, text: '张三丰 在吗 10:20' },
    { index: 1, text: '张三 测试消息 18分钟前' },
    { index: 2, text: 'Flear 重燃中 2/3 23分钟前 1' }
  ]

  it('前缀命中优先于包含命中（张三不会点到张三丰）', () => {
    expect(pickConversation(list, '张三')?.index).toBe(1)
  })

  it('昵称里带空格也能匹配', () => {
    expect(pickConversation(list, 'per.fect 17')).toBeNull()
    expect(pickConversation([{ index: 5, text: 'per.fect 17 18分钟前 测试' }], 'per.fect 17')?.index).toBe(5)
  })

  it('多个前缀命中时取最短的那个', () => {
    const multi = [
      { index: 0, text: '小明 很长很长的预览内容 12:00' },
      { index: 1, text: '小明 好 12:01' }
    ]
    expect(pickConversation(multi, '小明')?.index).toBe(1)
  })

  it('没有命中时返回 null', () => {
    expect(pickConversation(list, '李四')).toBeNull()
  })

  it('空标题直接返回 null，避免匹配到第一条', () => {
    expect(pickConversation(list, '   ')).toBeNull()
  })
})
