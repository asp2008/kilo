/**
 * KiloForm Playwright 执行引擎
 * WebSocket 服务器，前端发任务配置，实时推送日志/截图/验证码
 *
 * 移植并增强自参考 Python 脚本：
 *  - 多候选 OCR（6x放大 + 多阈值二值化）
 *  - 自动重试（失败则刷新页面重试，最多 maxAttempts 次）
 *  - 可配置成功/失败关键词
 *  - 直接截取验证码元素（不是整个页面截图）
 *
 * 启动: node server/playwright-engine.mjs
 * 端口: 3002
 */

import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { multiCandidateOcr } from './ocr-helper.mjs'

const PORT = 3002

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const httpServer = createServer(async (req, res) => {
  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  const reqUrl = new URL(req.url, `http://127.0.0.1:${PORT}`)

  // ── GET /health ──
  if (reqUrl.pathname === '/health') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // ── GET /fetch?url=... ── 服务端抓取页面 HTML，彻底无跨域限制
  if (reqUrl.pathname === '/fetch' && req.method === 'GET') {
    const targetUrl = reqUrl.searchParams.get('url')
    if (!targetUrl) {
      res.writeHead(400, CORS_HEADERS)
      res.end(JSON.stringify({ error: '缺少 url 参数' }))
      return
    }
    try {
      const b = await getBrowser()
      const ctx = await b.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      })
      const page = await ctx.newPage()
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
      const html = await page.content()
      await ctx.close()
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch (e) {
      console.error('[fetch]', e.message)
      res.writeHead(502, CORS_HEADERS)
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  res.writeHead(404, CORS_HEADERS)
  res.end()
})

const wss = new WebSocketServer({
  server: httpServer,
  // 允许任意来源连接（前端 localhost:5173 访问 127.0.0.1:3002）
  verifyClient: () => true,
})

let browser = null
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    })
  }
  return browser
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[ws] 客户端已连接')

  // 验证码等待队列
  const captchaQueue = []

  const send = (type, payload) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...payload }))
  }
  const log = (level, msg) => {
    console.log(`[${level}] ${msg}`)
    send('log', { level, message: msg, timestamp: new Date().toISOString() })
  }

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'run') {
      try {
        await runTask(msg.task, log, send, captchaQueue)
        send('done', { success: true })
      } catch (e) {
        log('error', `执行异常: ${e.message}`)
        send('done', { success: false, error: e.message })
      }
    }

    if (msg.type === 'captcha_reply') {
      const resolve = captchaQueue.shift()
      resolve?.(msg.value || '')
    }

    if (msg.type === 'stop') {
      log('warn', '用户停止执行')
      send('done', { success: false, error: '用户停止' })
    }
  })

  ws.on('close', () => console.log('[ws] 断开'))
})

// ─── 主执行逻辑 ───────────────────────────────────────────────────────────────
async function runTask(task, log, send, captchaQueue) {
  const cfg = task.config || {}
  const fields = deduplicateFields(cfg.fields || [])
  const captchaField = fields.find(f => f.isCaptcha)

  // 成功/失败关键词（从任务配置读取）
  const successKws = cfg.successKeywords || []
  const failureKws = cfg.failureKeywords || ['エラー', 'error', 'invalid', '错误', '失敗', 'もう一度', '認証.*失敗']
  const captchaLen = cfg.captcha?.captchaLength || 4
  const maxAttempts = cfg.maxAttempts || 5

  const b = await getBrowser()
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  try {
    // ── 重试循环（对应 Python 的 for attempt in range(max_attempts)）──
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log('info', attempt === 1 ? `打开页面: ${task.url}` : `[重试 ${attempt}/${maxAttempts}] 刷新页面...`)

      await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(500)

      // ── 填充普通字段 ──
      for (const field of fields) {
        if (field.type === 'hidden' || field.type === 'file' || field.isCaptcha) continue
        if (!field.fillValue && field.fillValue !== 0) continue

        try {
          const el = await page.$(field.selector)
          if (!el) { log('warn', `未找到: ${field.selector}`); continue }

          const tag = await el.evaluate(e => e.tagName.toLowerCase())
          const type = await el.evaluate(e => (e.type || '').toLowerCase())

          if (tag === 'select') {
            await el.selectOption({ value: String(field.fillValue) }).catch(() =>
              el.selectOption({ label: String(field.fillValue) })
            )
          } else if (type === 'checkbox' || type === 'radio') {
            const checked = ['true', '1', 'yes', 'on'].includes(String(field.fillValue).toLowerCase())
            checked ? await el.check({ force: true }) : await el.uncheck({ force: true })
          } else {
            await el.fill(String(field.fillValue))
          }
          log('info', `填充 "${field.label || field.key}" = "${String(field.fillValue).slice(0, 60)}"`)
          await page.waitForTimeout(100)
        } catch (e) {
          log('warn', `字段 "${field.key}" 填充失败: ${e.message}`)
        }
      }

      // ── 验证码处理 ──
      let captchaText = ''
      if (captchaField) {
        captchaText = await handleCaptcha(page, captchaField, cfg, captchaLen, attempt, log, send, captchaQueue)
        if (!captchaText) {
          log('warn', `[尝试 ${attempt}] 验证码为空，跳过本次提交`)
          continue
        }
      }

      // ── 提交 ──
      if (cfg.autoSubmit !== false) {
        const submitSel = cfg.submitSelector ||
          'input[type="submit"],button[type="submit"],button:has-text("投稿"),button:has-text("送信"),button:has-text("Submit")'

        log('info', '点击提交...')
        try {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
            page.click(submitSel, { timeout: 5000 }).catch(() =>
              page.evaluate(() => document.querySelector('form')?.submit())
            ),
          ])
        } catch (e) {
          log('warn', `提交等待超时，继续分析页面: ${e.message}`)
        }
        await page.waitForTimeout(1000)
      }

      // ── 截图 ──
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 75 })
      send('screenshot', { data: screenshot.toString('base64') })

      // ── 结果分析 ──
      const result = await analyzeResult(page, task.url, successKws, failureKws, log, send)

      if (result === 'success') {
        log('success', `✅ 第 ${attempt} 次尝试成功！`)
        return
      } else if (result === 'failure') {
        if (attempt < maxAttempts) {
          log('warn', `❌ 第 ${attempt} 次失败，准备重试...`)
          await page.waitForTimeout(800)
          // 继续 for 循环（会 goto 刷新页面）
        } else {
          log('error', `❌ 已达最大重试次数 (${maxAttempts})，放弃`)
          return
        }
      } else {
        // unknown — 无法判断，展示给用户
        log('warn', `⚠️ 第 ${attempt} 次：无法确认结果，请查看截图`)
        return
      }
    }
  } finally {
    await context.close()
  }
}

// ─── 验证码处理 ───────────────────────────────────────────────────────────────
async function handleCaptcha(page, field, cfg, captchaLen, attempt, log, send, captchaQueue) {
  log('info', `处理验证码字段: "${field.label || field.key}"`)

  const solver = cfg.captcha?.solver || 'tesseract'

  // 截取验证码图片元素（直接截图元素，比截全屏更精准）
  const captchaImgEl = await findCaptchaImageElement(page, field.selector)
  let captchaBuffer = null

  if (captchaImgEl) {
    captchaBuffer = await captchaImgEl.screenshot({ type: 'png' })
    log('info', `验证码图片已截取 (${captchaBuffer.length} bytes)`)

    // 发送验证码图片到前端预览
    send('captcha_image', { data: `data:image/png;base64,${captchaBuffer.toString('base64')}` })
  } else {
    log('warn', '未找到独立验证码图片元素，截取整个页面供参考')
    const full = await page.screenshot({ type: 'jpeg', quality: 60 })
    send('captcha_image', { data: `data:image/jpeg;base64,${full.toString('base64')}` })
  }

  let captchaText = ''

  if (solver === 'manual') {
    log('info', '⏳ 等待人工输入验证码...')
    captchaText = await waitForCaptchaInput(captchaQueue, 60000)
    log('info', `人工输入: "${captchaText}"`)
  } else if (captchaBuffer) {
    // 多候选 OCR（移植自 Python build_candidates + ocr_with_candidates）
    log('info', `OCR 多候选识别中（期望长度 ${captchaLen}）...`)
    const { text, logs: ocrLogs } = await multiCandidateOcr(captchaBuffer, captchaLen)

    const logStr = ocrLogs.map(l => `${l.label}:${l.text}`).join(' | ')
    log('info', `OCR 候选: ${logStr}`)
    log('info', `OCR 最终结果: "${text}"`)

    if (text.length >= captchaLen) {
      captchaText = text
    } else {
      // OCR 结果不够 → 转人工
      log('warn', `OCR 结果 "${text}" 不足 ${captchaLen} 位，转为人工输入`)
      captchaText = await waitForCaptchaInput(captchaQueue, 60000)
      log('info', `人工输入: "${captchaText}"`)
    }
  } else {
    log('warn', '无验证码图片，人工输入')
    captchaText = await waitForCaptchaInput(captchaQueue, 60000)
  }

  // 填入验证码
  if (captchaText) {
    try {
      const el = await page.$(field.selector)
      if (el) {
        await el.fill(captchaText)
        log('info', `验证码已填入: "${captchaText}"`)
      }
    } catch (e) {
      log('warn', `验证码填入失败: ${e.message}`)
    }
  }

  return captchaText
}

// ─── 查找验证码图片元素 ────────────────────────────────────────────────────────
async function findCaptchaImageElement(page, inputSelector) {
  // 策略1: 找输入框附近的 img
  const imgEl = await page.evaluate((sel) => {
    const input = document.querySelector(sel)
    if (!input) return null
    const root = input.closest('.captcha,.verify-group,form,.form-group,tr,td') || input.parentElement
    if (!root) return null
    const candidates = [
      root.querySelector("img[src*='captcha']"),
      root.querySelector("img[src*='verify']"),
      root.querySelector("img[src*='code']"),
      root.querySelector("img[src*='kana']"),
      root.querySelector("img[alt*='キー']"),
      root.querySelector("img[alt*='認証']"),
      root.querySelector('img'),
    ]
    const found = candidates.find(Boolean)
    return found ? found.getAttribute('src') : null
  }, inputSelector)

  if (!imgEl) return null

  // 策略2: 通过 src 定位元素
  return page.$(`img[src="${imgEl}"]`).catch(() => null)
}

// ─── 结果分析（移植自 Python detect_result）─────────────────────────────────
async function analyzeResult(page, originalUrl, successKws, failureKws, log, send) {
  const currentUrl = page.url()
  const title = await page.title().catch(() => '')

  const bodyText = await page.evaluate(() => {
    const clone = document.body.cloneNode(true)
    clone.querySelectorAll('script,style,noscript').forEach(e => e.remove())
    return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim()
  }).catch(() => '')

  const snippet = bodyText.slice(0, 500)
  const redirected = currentUrl !== originalUrl

  log('info', `当前 URL: ${currentUrl}`)
  if (title) log('info', `页面标题: ${title}`)

  // 先检查失败关键词（优先级更高，对应 Python detect_result 的顺序）
  const defaultFailPatterns = [
    /エラー|error/i, /认证.*失败|認証.*失敗|captcha.*wrong/i,
    /もう一度|再入力|try again/i, /invalid|incorrect/i,
    /不正|失敗|失败|错误/i, /spam|bot/i,
  ]
  const failPatterns = [
    ...defaultFailPatterns,
    ...failureKws.map(k => new RegExp(k, 'i')),
  ]
  const successPatterns = [
    /投稿しました|投稿完了|書き込み.*完了|送信.*完了|登録.*完了/,
    /success|posted|registered|ありがとう|thank/i,
    /完成|成功|提交成功/,
    ...successKws.map(k => new RegExp(k, 'i')),
  ]

  const foundFail = failPatterns.find(p => p.test(bodyText))
  const foundSuccess = successPatterns.find(p => p.test(bodyText))

  log('info', `页面内容（前500字）: ${snippet}`)

  if (foundFail) {
    const match = bodyText.match(foundFail)
    log('error', `❌ 失败: 检测到关键词 "${match?.[0]}"`)
    return 'failure'
  }
  if (foundSuccess) {
    const match = bodyText.match(foundSuccess)
    log('success', `✅ 成功: 检测到关键词 "${match?.[0]}"`)
    return 'success'
  }
  if (redirected) {
    log('success', `✅ 页面已跳转至: ${currentUrl}，判断为成功`)
    return 'success'
  }

  log('warn', '⚠️ 无法自动判断结果，请查看截图')
  return 'unknown'
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function deduplicateFields(fields) {
  const seen = new Set()
  return fields.filter(f => { if (seen.has(f.key)) return false; seen.add(f.key); return true })
}

function waitForCaptchaInput(queue, timeout = 60000) {
  return new Promise((resolve) => {
    queue.push(resolve)
    setTimeout(() => resolve(''), timeout)
  })
}

// ─── 启动 ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ KiloForm Playwright 引擎已启动: ws://127.0.0.1:${PORT}`)
})
