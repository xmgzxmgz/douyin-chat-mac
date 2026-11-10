let counter = 0

export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`
}

export function shortId(id: string, len = 6): string {
  return id.length <= len ? id : id.slice(-len)
}
