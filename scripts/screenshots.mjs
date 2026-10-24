// Usage: npm run build:demo && node scripts/screenshots.mjs (PUPPETEER_FROM=<dir with puppeteer in node_modules>)
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'client', 'dist-demo')
const out = join(root, 'docs', 'screenshots')
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build the demo first: npm run build:demo')
mkdirSync(out, { recursive: true })

const require = createRequire(import.meta.url)
const from = process.env.PUPPETEER_FROM
const { default: puppeteer, KnownDevices } = await import(
  pathToFileURL(require.resolve('puppeteer', from ? { paths: [from] } : undefined)).href
)

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' }

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = join(dist, path === '/' ? 'index.html' : path)
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function open(viewport, device) {
  const page = await browser.newPage()
  page.on('pageerror', (err) => console.error('[page error]', err.message))
  if (device) await page.emulate(device)
  else await page.setViewport(viewport)
  await page.emulateTimezone('America/New_York')
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.queue-item')
  return page
}

async function clickText(page, selector, text) {
  const handle = await page.waitForFunction(
    (sel, t) => [...document.querySelectorAll(sel)].find((el) => el.textContent?.includes(t)) ?? null,
    {},
    selector,
    text,
  )
  await handle.asElement().click()
}

async function shot(page, name) {
  await sleep(400)
  await page.screenshot({ path: join(out, `${name}.png`) })
  console.log(`saved docs/screenshots/${name}.png`)
}

const desktop = { width: 1440, height: 900, deviceScaleFactor: 1 }

// 1. The dialer mid-call: queue, call guide and lead card, live call panel.
{
  const page = await open(desktop)
  await clickText(page, '.call-pane button.primary', 'Call ')
  await page.waitForFunction(() => document.querySelector('.call-phase')?.textContent === 'Connected')
  await sleep(4200)
  await shot(page, 'dialer')
  await page.close()
}

// 2. A transcript: both sides of the call, searched and highlighted.
{
  const page = await open(desktop)
  await clickText(page, '.tabs button', 'Transcripts')
  await page.waitForSelector('.transcripts-table tbody tr:not(.skeleton-row)')
  await page.type('.toolbar-search', 'front desk')
  await page.waitForFunction(() => document.querySelector('.transcripts-table tbody tr mark'))
  await page.click('.transcripts-table tbody tr')
  await page.waitForSelector('.conversation .bubble')
  await shot(page, 'transcript')
  await page.close()
}

// 3. Metrics, with the AI receptionist's callbacks opened.
{
  const page = await open(desktop)
  await clickText(page, '.tabs button', 'Metrics')
  await page.waitForSelector('.stat-toggle')
  await page.click('.stat-toggle')
  await page.waitForSelector('.callbacks-table tbody tr:not(.skeleton-row)')
  await shot(page, 'metrics')
  await page.close()
}

// 4. Setup: workspace checks and a connection test result.
{
  const page = await open(desktop)
  await clickText(page, '.tabs button', 'Setup')
  await clickText(page, 'button', 'Run connection test')
  await page.waitForFunction(() => [...document.querySelectorAll('.badge')].some((b) => b.textContent?.startsWith('Good')))
  await shot(page, 'setup')
  await page.close()
}

// 5. A phone, 390 px wide, during a call.
{
  const iphone = KnownDevices['iPhone 13']
  const page = await open(null, { ...iphone, viewport: { ...iphone.viewport, deviceScaleFactor: 2 } })
  await clickText(page, '.call-bar button.primary', 'Call')
  await page.waitForFunction(() => document.querySelector('.call-bar-status')?.textContent?.startsWith('Connected'))
  await sleep(3200)
  await shot(page, 'mobile')
  await page.close()
}

await browser.close()
server.close()
