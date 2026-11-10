/**
 * 生成应用图标：用 Electron 离屏渲染一张 1024×1024 PNG。
 * 运行：env -u ELECTRON_RUN_AS_NODE npx electron scripts/make-icon.cjs
 */
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff6a86"/>
      <stop offset="0.55" stop-color="#fe2c55"/>
      <stop offset="1" stop-color="#d8113f"/>
    </linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="26" flood-color="#7a0018" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="232" fill="url(#g)"/>
  <rect x="24" y="24" width="976" height="976" rx="212" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="4"/>
  <g filter="url(#s)">
    <path d="M512 236c-148 0-268 102-268 228 0 72 40 136 102 178l-22 102c-4 20 17 35 34 24l112-75c14 2 28 3 42 3 148 0 268-102 268-232S660 236 512 236z" fill="#ffffff"/>
  </g>
  <circle cx="398" cy="470" r="27" fill="#fe2c55"/>
  <circle cx="512" cy="470" r="27" fill="#fe2c55"/>
  <circle cx="626" cy="470" r="27" fill="#fe2c55"/>
</svg>`

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, zoomFactor: 1 }
  })
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${SVG}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 600))
  const image = await win.webContents.capturePage()
  mkdirSync(join(__dirname, '..', 'build'), { recursive: true })
  const out = join(__dirname, '..', 'build', 'icon.png')
  writeFileSync(out, image.toPNG())
  console.log('icon written:', out, image.getSize())
  app.quit()
})
