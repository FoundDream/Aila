import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = resolve(rootDir, 'apps/desktop')
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sourceSvg = resolve(desktopDir, 'build/icon.svg')
const buildDir = resolve(desktopDir, 'build')
const iconsetDir = resolve(buildDir, 'icon.iconset')
const pngDir = resolve(buildDir, 'icons')
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const icoSizes = [16, 32, 48, 64, 128, 256]
const chromeProfilePrefix = '.chrome-icon-profile-'

async function findOpenPort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePort(address.port))
    })
  })
}

async function waitForPageTarget(port) {
  const url = `http://127.0.0.1:${port}/json/list`
  const start = Date.now()

  while (Date.now() - start < 15_000) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
        if (page) return page
      }
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }

  throw new Error('Timed out waiting for a Chrome page target')
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  let nextId = 1
  const callbacks = new Map()
  const listeners = new Map()

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)

    if (message.id && callbacks.has(message.id)) {
      const { resolveCallback, rejectCallback } = callbacks.get(message.id)
      callbacks.delete(message.id)
      if (message.error) rejectCallback(new Error(message.error.message))
      else resolveCallback(message.result)
      return
    }

    const listener = listeners.get(message.method)
    if (listener) listener(message.params)
  })

  return new Promise((resolveConnection, rejectConnection) => {
    socket.addEventListener('open', () => {
      resolveConnection({
        send(method, params = {}) {
          const id = nextId++
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((resolveCallback, rejectCallback) => {
            callbacks.set(id, { resolveCallback, rejectCallback })
          })
        },
        once(method) {
          return new Promise((resolveListener) => {
            listeners.set(method, (params) => {
              listeners.delete(method)
              resolveListener(params)
            })
          })
        },
        close() {
          socket.close()
        },
      })
    })
    socket.addEventListener('error', rejectConnection)
  })
}

function makeIconHtml(svg) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }

      svg {
        display: block;
        width: 100vw;
        height: 100vh;
      }
    </style>
  </head>
  <body>${svg}</body>
</html>`
}

async function capturePng(cdp, html, size, outputPath) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size,
    height: size,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  })

  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', {
    url: `data:text/html;base64,${Buffer.from(html).toString('base64')}`,
  })
  await loaded

  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
  })

  await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'))
}

function makeIco(entries) {
  const headerSize = 6
  const directorySize = 16 * entries.length
  let offset = headerSize + directorySize
  const header = Buffer.alloc(headerSize + directorySize)

  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  entries.forEach(({ size, buffer }, index) => {
    const entryOffset = headerSize + index * 16
    header.writeUInt8(size >= 256 ? 0 : size, entryOffset)
    header.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1)
    header.writeUInt8(0, entryOffset + 2)
    header.writeUInt8(0, entryOffset + 3)
    header.writeUInt16LE(1, entryOffset + 4)
    header.writeUInt16LE(32, entryOffset + 6)
    header.writeUInt32LE(buffer.length, entryOffset + 8)
    header.writeUInt32LE(offset, entryOffset + 12)
    offset += buffer.length
  })

  return Buffer.concat([header, ...entries.map((entry) => entry.buffer)])
}

async function runIconutil() {
  await new Promise((resolveProcess, rejectProcess) => {
    const process = spawn('iconutil', ['-c', 'icns', iconsetDir, '-o', resolve(buildDir, 'icon.icns')], {
      stdio: 'inherit',
    })
    process.on('error', rejectProcess)
    process.on('exit', (code) => {
      if (code === 0) resolveProcess()
      else rejectProcess(new Error(`iconutil exited with code ${code}`))
    })
  })
}

async function cleanupChromeProfiles() {
  try {
    const entries = await readdir(buildDir, { withFileTypes: true })
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(chromeProfilePrefix))
        .map((entry) => rm(resolve(buildDir, entry.name), { recursive: true, force: true })),
    )
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function stopChrome(chrome) {
  if (chrome.exitCode !== null) return

  chrome.kill()
  await new Promise((resolveProcess) => {
    chrome.once('exit', resolveProcess)
    setTimeout(resolveProcess, 2_000)
  })
}

async function main() {
  const svg = await readFile(sourceSvg, 'utf8')
  const port = await findOpenPort()
  const profileDir = resolve(buildDir, `${chromeProfilePrefix}${Date.now()}`)

  await mkdir(buildDir, { recursive: true })
  await cleanupChromeProfiles()
  await rm(iconsetDir, { recursive: true, force: true })
  await mkdir(iconsetDir, { recursive: true })
  await mkdir(pngDir, { recursive: true })

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ])

  try {
    const page = await waitForPageTarget(port)
    const cdp = await connectCdp(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')

    const html = makeIconHtml(svg)

    for (const size of pngSizes) {
      const outputPath = resolve(pngDir, `${size}x${size}.png`)
      await capturePng(cdp, html, size, outputPath)
      console.log(`generated ${basename(outputPath)}`)
    }

    await capturePng(cdp, html, 512, resolve(buildDir, 'icon.png'))

    cdp.close()
  } finally {
    await stopChrome(chrome)
    await rm(profileDir, { recursive: true, force: true })
  }
  await cleanupChromeProfiles()

  const iconsetNames = [
    ['16x16.png', 'icon_16x16.png'],
    ['32x32.png', 'icon_16x16@2x.png'],
    ['32x32.png', 'icon_32x32.png'],
    ['64x64.png', 'icon_32x32@2x.png'],
    ['128x128.png', 'icon_128x128.png'],
    ['256x256.png', 'icon_128x128@2x.png'],
    ['256x256.png', 'icon_256x256.png'],
    ['512x512.png', 'icon_256x256@2x.png'],
    ['512x512.png', 'icon_512x512.png'],
    ['1024x1024.png', 'icon_512x512@2x.png'],
  ]

  for (const [source, destination] of iconsetNames) {
    await writeFile(
      resolve(iconsetDir, destination),
      await readFile(resolve(pngDir, source)),
    )
  }

  await runIconutil()
  await rm(iconsetDir, { recursive: true, force: true })

  const icoEntries = await Promise.all(
    icoSizes.map(async (size) => ({
      size,
      buffer: await readFile(resolve(pngDir, `${size}x${size}.png`)),
    })),
  )
  await writeFile(resolve(buildDir, 'icon.ico'), makeIco(icoEntries))

  console.log(`generated ${pathToFileURL(resolve(buildDir, 'icon.icns')).href}`)
  console.log(`generated ${pathToFileURL(resolve(buildDir, 'icon.ico')).href}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
