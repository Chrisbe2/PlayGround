import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const url = process.env.CAPTURE_URL
const output = process.env.CAPTURE_DIR
if (!url || !output) {
  console.error('Set CAPTURE_URL and CAPTURE_DIR.')
  process.exit(1)
}

const outDir = resolve(output)
const started = Date.now()
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])
const views = [
  ['desktop', 1440, 900],
  ['mobile', 390, 844]
]

function failure(message, cause, exitCode) {
  const error = new Error(message, { cause })
  error.exitCode = exitCode
  return error
}

async function timed(name, task) {
  const begin = Date.now()
  try {
    return await task()
  } finally {
    console.log(`[timing] ${name}: ${Date.now() - begin} ms`)
  }
}

try {
  mkdirSync(outDir, { recursive: true })
} catch (error) {
  console.error(`Cannot create CAPTURE_DIR ${outDir}: ${error.message}`)
  process.exit(1)
}

const runtime = join(homedir(), '.local/share/omgithub-playwright')
let chromium
let config
try {
  const require = createRequire(join(runtime, 'package.json'))
  ;({ chromium } = require('playwright'))
  const configPath = join(runtime, process.platform === 'darwin' ? 'metal.json' : 'linux.json')
  config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (process.platform === 'linux') {
    process.env.DISPLAY ||= ':' + readFileSync(join(runtime, 'display'), 'utf8').trim()
  }
} catch (error) {
  console.error(`Playwright runtime is unavailable: ${error.message}`)
  process.exit(1)
}

let browser
let exitCode = 0

try {
  try {
    browser = await timed('browser launch', () =>
      chromium.launch({ ...config.browser.launchOptions, timeout: 30000 })
    )
  } catch (error) {
    throw failure('Browser launch failed.', error, 75)
  }

  for (const [name, width, height] of views) {
    let page
    const pageErrors = []

    try {
      try {
        page = await timed(`new ${name} page`, () =>
          browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
        )
      } catch (error) {
        throw failure(`Could not open the ${name} page.`, error, 75)
      }

      page.setDefaultTimeout(30000)
      page.on('pageerror', error => {
        console.error(`[${name}] page error: ${error.message}`)
        pageErrors.push(error.message)
      })
      page.on('response', response => {
        if (response.status() < 400) return
        try {
          if (new URL(response.url()).origin === new URL(url).origin) {
            pageErrors.push(`HTTP ${response.status()}: ${response.url()}`)
          }
        } catch {
          // Ignore responses that are not valid URLs.
        }
      })

      let response
      try {
        response = await timed(`navigate ${name}`, () =>
          page.goto(url, { waitUntil: 'load', timeout: 45000 })
        )
      } catch (error) {
        throw failure(`Navigation failed for the ${name} view.`, error, 75)
      }

      if (!response) {
        throw failure(`No response received for the ${name} view.`, null, 75)
      }
      if (!response.ok()) {
        const status = response.status()
        throw failure(
          `HTTP ${status} loading ${url}`,
          null,
          TRANSIENT_STATUS.has(status) ? 75 : 1
        )
      }

      try {
        const selector = process.env.CAPTURE_READY_SELECTOR || 'body'
        await timed(`wait for ${name} selector`, () =>
          page.locator(selector).waitFor({ state: 'visible', timeout: 15000 })
        )
        await timed(`wait for ${name} fonts`, () =>
          page.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 15000 })
        )
        await timed(`wait for ${name} content`, () =>
          page.waitForFunction(
            () => {
              const body = document.body
              if (!body) return false
              const text = (body.innerText || '').trim()
              return text.length > 0 ||
                Boolean(body.querySelector('canvas, svg, img, video, iframe'))
            },
            null,
            { timeout: 15000 }
          )
        )
        await timed(`settle ${name}`, () => page.waitForTimeout(800))
      } catch (error) {
        throw failure(`The ${name} view did not render visible content.`, error, 1)
      }

      const path = join(outDir, `final-${name}.png`)
      try {
        await timed(`screenshot ${name}`, () =>
          page.screenshot({ path, timeout: 30000 })
        )
      } catch (error) {
        const transient = error.name === 'TimeoutError' || !browser.isConnected()
        throw failure(`Screenshot failed for the ${name} view.`, error, transient ? 75 : 1)
      }

      if (process.env.CAPTURE_STRICT === '1' && pageErrors.length) {
        throw failure(`The ${name} view reported failures: ${pageErrors.join('; ')}`, null, 1)
      }
    } finally {
      if (page) {
        try {
          await page.close()
        } catch (error) {
          console.error(`Could not close the ${name} page: ${error.message}`)
        }
      }
    }
  }

  for (const [name] of views) {
    const path = join(outDir, `final-${name}.png`)
    let bytes
    try {
      bytes = readFileSync(path)
    } catch (error) {
      throw failure(`Missing screenshot ${path}.`, error, 1)
    }
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw failure(`Screenshot ${path} is not a valid PNG.`, null, 1)
    }
  }
} catch (error) {
  console.error(error.stack || String(error))
  exitCode = error.exitCode === 75 ? 75 : 1
} finally {
  if (browser) {
    try {
      await timed('browser close', () => browser.close())
    } catch (error) {
      console.error(`Could not close the browser: ${error.message}`)
      if (!exitCode) exitCode = 75
    }
  }
  console.log(`[timing] total capture: ${Date.now() - started} ms`)
}

process.exit(exitCode)
