import React from 'react'

const PATHS: Record<string, React.ReactNode> = {
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.3-.6L3 21l1.7-5A8.3 8.3 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />,
  users: (
    <>
      <path d="M16 19v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V19" />
      <circle cx="9" cy="7" r="3.4" />
      <path d="M22 19v-1.5a4 4 0 0 0-3-3.87" />
      <path d="M16.5 4.2a3.4 3.4 0 0 1 0 6.6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.03 4.1l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  pin: <path d="M9 4h6l-1 6 4 4v2h-5v6l-1 1-1-1v-6H6v-2l4-4-1-6Z" />,
  bellOff: (
    <>
      <path d="M18 8a6 6 0 0 0-9.3-5" />
      <path d="M6.3 6.3A6 6 0 0 0 6 8c0 7-3 8-3 8h13" />
      <path d="M10.3 21a2 2 0 0 0 3.4 0" />
      <path d="m3 3 18 18" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
      <path d="M10.3 21a2 2 0 0 0 3.4 0" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  send: <path d="M4 12 21 4l-7 17-3-7-7-2Z" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4 18 5-5 4 4 3-3 4 4" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </>
  ),
  reply: <path d="M9 14 4 9l5-5M4 9h9a7 7 0 0 1 7 7v3" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
    </>
  ),
  check: <path d="m4 12.5 5 5L20 6.5" />,
  alert: (
    <>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  qr: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 20h3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8 2 2-2 2 2 2-3 3-2-2-1 1" />
    </>
  ),
  close: <path d="M5 5l14 14M19 5 5 19" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </>
  ),
  wifi: (
    <>
      <path d="M5 12.5a10 10 0 0 1 14 0" />
      <path d="M8.5 16a5.5 5.5 0 0 1 7 0" />
      <path d="M12 19.5h.01" />
    </>
  )
}

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.7,
  className
}: {
  name: keyof typeof PATHS | string
  size?: number
  strokeWidth?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name] ?? null}
    </svg>
  )
}
