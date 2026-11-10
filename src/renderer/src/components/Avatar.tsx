import React, { useState } from 'react'

function hueOf(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

export function Avatar({
  src,
  name,
  size = 44,
  online,
  square = false
}: {
  src?: string
  name: string
  size?: number
  online?: boolean
  square?: boolean
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const hue = hueOf(name || '?')
  const showImage = src && !failed

  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        borderRadius: square ? size * 0.28 : size / 2,
        background: showImage ? '#eef0f4' : `linear-gradient(140deg, hsl(${hue} 78% 62%), hsl(${(hue + 40) % 360} 72% 52%))`
      }}
    >
      {showImage ? (
        <img src={src} alt={name} onError={() => setFailed(true)} draggable={false} />
      ) : (
        <span style={{ fontSize: size * 0.4 }}>{(name || '?').slice(0, 1)}</span>
      )}
      {online ? <i className="avatar-online" /> : null}
    </div>
  )
}
