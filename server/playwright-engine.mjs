/**
 * KiloForm Playwright 执行引擎
 * WebSocket 服务器，前端发送任务配置，实时推送执行日志和截图
 *
 * 启动: node server/playwright-engine.mjs
 * 端口: 3002
 */

import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'

const PORT = 3002

// HTTP 服务（健康检查）
const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } else {
    res.writeHead(404)
    res.end()
  }
})

const wss = new WebSocketServer({ server: httpServer })

// 全局浏览器实例（复用）
let browser = null

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: false,   // 显示浏览器窗口，方便用户观察
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',   // 隐藏自动化特征
        '--disable-infobars',
      ],
    })
  }
  return browser
}

// ─── WebSocket 连接处理 ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[ws] 客户端已连接')

  const send = (type, payload) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, ...payload }))
    }
  }

  const log = (level, message) => {
    console.log(`[${level}] ${message}`)
    send('log', { level, message, timestamp: new Date().toISOString() })
  }

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'run') {
      try {
        await runTask(msg.task, log, send)
        send('done', { success: true })
      } catch (e) {
        log('error', `执行异常: ${e.message}`)
        send('done', { success: false, error: e.message })
      }
    }

    if (msg.type === 'captcha_reply') {
      // 验证码用户输入回调（通过全局 resolver）
      if (global.__captchaResolvers) {
        const resolver = global.__captchaResolvers.shift()
        if (resolver) resolver(msg.value || '')
      }
    }

    if (msg.type === 'stop') {
      log('warn', '用户请求停止')
      send('done', { success: false, error: '用户停止' })
    }
  })

  ws.on('close', () => console.log('[ws] 客户端断开'))
})

// ─── 核心执行逻辑 ─────────────────────────────────────────────────────────────
async function runTask(task, log, send) {
  global.__captchaResolvers = []

  const b = await getBrowser()
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  try {
    // 1. 打开目标页面
    log('info', `打开页面: ${task.url}`)
    await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    log('info', '页面加载完成')

    const fields = deduplicateFields(task.config?.fields || [])

    // 2. 逐字段填充
    for (const field of fields) {
      if (field.type === 'hidden' || field.type === 'file') continue

      if (field.isCaptcha) {
        await handleCaptcha(page, field, task, log, send)
        continue
      }

      if (!field.fillValue && field.fillValue !== 0) {
        log('warn', `"${field.label || field.key}" 无填充值，跳过`)
        continue
      }

      try {
        const el = await page.$(field.selector)
        if (!el) {
          log('warn', `未找到元素: ${field.selector}`)
          continue
        }

        const tagName = await el.evaluate(e => e.tagName.toLowerCase())
        const elType = await el.evaluate(e => e.type?.toLowerCase())

        if (tagName === 'select') {
          await el.selectOption({ value: String(field.fillValue) })
        } else if (elType === 'checkbox' || elType === 'radio') {
          const checked = String(field.fillValue).toLowerCase()
          if (['true', '1', 'yes', 'on'].includes(checked)) {
            await el.check()
          }
        } else {
          await el.fill(String(field.fillValue))
        }

        log('info', `填充 "${field.label || field.key}" = "${String(field.fillValue).slice(0, 60)}"`)
        await page.waitForTimeout(150)
      } catch (e) {
        log('warn', `字段 "${field.key}" 填充失败: ${e.message}`)
      }
    }

    // 3. 自动提交
    if (task.config?.autoSubmit) {
      await page.waitForTimeout(300)
      log('info', '点击提交按钮...')

      const submitSel = task.config.submitSelector ||
        'input[type="submit"], button[type="submit"], button:has-text("投稿"), button:has-text("送信"), button:has-text("Submit")'

      const submitBtn = await page.$(submitSel)
      if (submitBtn) {
        await submitBtn.click()
      } else {
        await page.evaluate(() => document.querySelector('form')?.submit())
      }

      // 4. 等待页面响应
      log('info', '等待页面响应...')
      await page.waitForTimeout(2000)

      // 5. 判断结果
      await analyzeResult(page, task.url, log, send)
    } else {
      log('info', '自动提交未启用，已填充完毕')
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 })
      send('screenshot', { data: screenshot.toString('base64') })
    }

  } finally {
    await context.close()
  }
}

// ─── 验证码处理 ───────────────────────────────────────────────────────────────
async function handleCaptcha(page, field, task, log, send) {
  log('info', `处理验证码字段: "${field.label || field.key}"`)

  const solver = task.config?.captcha?.solver || 'tesseract'
  let captchaText = ''

  // 找验证码图片元素
  const captchaImgEl = await findCaptchaImage(page, field.selector)

  if (captchaImgEl) {
    // 截取验证码图片
    const imgBuffer = await captchaImgEl.screenshot({ type: 'png' })
    const imgBase64 = `data:image/png;base64,${imgBuffer.toString('base64')}`
    log('info', '已截取验证码图片')
    send('captcha_image', { data: imgBase64 })

    if (solver === 'manual') {
      // 等待用户输入
      captchaText = await waitForCaptchaInput(log)
    } else {
      // Tesseract OCR（动态加载）
      try {
        const { createWorker } = await import('tesseract.js')
        log('info', 'OCR 识别中...')
        const worker = await createWorker('eng')
        await worker.setParameters({
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        })
        const { data: { text } } = await worker.recognize(imgBuffer)
        await worker.terminate()
        captchaText = text.trim().replace(/\s+/g, '')
        log('info', `OCR 结果: "${captchaText}"`)
      } catch (e) {
        log('warn', `OCR 失败: ${e.message}，转为人工输入`)
      }

      if (!captchaText) {
        log('warn', 'OCR 无法识别，请人工输入验证码')
        captchaText = await waitForCaptchaInput(log)
      }
    }
  } else {
    // 截图整个页面帮助用户定位
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 })
    send('captcha_image', { data: `data:image/jpeg;base64,${screenshot.toString('base64')}` })
    log('warn', '未找到验证码图片，请在截图中查看并人工输入')
    captchaText = await waitForCaptchaInput(log)
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
}

async function findCaptchaImage(page, inputSelector) {
  // 在输入框附近找图片
  const img = await page.evaluate((sel) => {
    const input = document.querySelector(sel)
    if (!input) return null
    const root = input.closest('.captcha,.verify-group,form,.form-group,tr,td') || input.parentElement
    if (!root) return null
    const img = root.querySelector('img[src*="captcha"],img[src*="verify"],img[src*="code"],img[src*="check"],img[src*="kana"],img')
    return img ? img.src : null
  }, inputSelector)

  if (!img) return null

  // 用 src 找到元素
  return page.$(`img[src="${img}"]`).catch(() => null)
}

function waitForCaptchaInput(log) {
  return new Promise(resolve => {
    log('info', '⏳ 等待人工输入验证码...')
    global.__captchaResolvers.push(resolve)
    // 60 秒超时
    setTimeout(() => resolve(''), 60000)
  })
}

// ─── 结果分析 ─────────────────────────────────────────────────────────────────
async function analyzeResult(page, originalUrl, log, send) {
  const currentUrl = page.url()
  const pageTitle = await page.title().catch(() => '')

  // 抓取页面纯文字（去脚本/样式）
  const bodyText = await page.evaluate(() => {
    const clone = document.body.cloneNode(true)
    clone.querySelectorAll('script,style,noscript').forEach(el => el.remove())
    return clone.innerText || clone.textContent || ''
  }).catch(() => '')

  const text = bodyText.replace(/\s+/g, ' ').trim()
  const snippet = text.slice(0, 500)

  log('info', `当前 URL: ${currentUrl}`)
  log('info', `页面标题: ${pageTitle}`)

  const redirected = currentUrl !== originalUrl

  // 成功关键词
  const successPatterns = [
    /投稿しました|投稿完了|書き込み.*完了|送信.*完了|登録.*完了/,
    /success|posted|registered|ありがとう|thank you/i,
    /記事が投稿|コメントが送信|メッセージが/,
    /完成|成功|提交成功/,
  ]
  // 失败关键词
  const errorPatterns = [
    /エラー|error|错误|失敗|失败/i,
    /認証.*失敗|captcha.*wrong|画像認証|入力.*間違/,
    /regikey|スパム|spam/i,
    /もう一度|再入力|やり直|try again/i,
    /invalid|incorrect|not found/i,
  ]

  const isSuccess = successPatterns.some(p => p.test(text))
  const isError = errorPatterns.some(p => p.test(text))

  // 截图
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 75 })
  send('screenshot', { data: screenshot.toString('base64') })

  if (isSuccess && !isError) {
    log('success', `✅ 提交成功！`)
    if (redirected) log('success', `页面跳转到: ${currentUrl}`)
    log('info', `页面内容: ${snippet}`)
  } else if (isError) {
    log('error', `❌ 提交失败，服务端报错`)
    log('error', `页面内容: ${snippet}`)
  } else if (redirected) {
    log('success', `✅ 提交完成（页面已跳转到: ${currentUrl}）`)
    log('info', `页面内容: ${snippet}`)
  } else {
    log('warn', `⚠️ 提交完成，请查看截图确认结果`)
    log('info', `页面内容（前500字）: ${snippet}`)
  }
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────
function deduplicateFields(fields) {
  const seen = new Set()
  return fields.filter(f => { if (seen.has(f.key)) return false; seen.add(f.key); return true })
}

// ─── 启动 ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ KiloForm Playwright 引擎已启动: ws://127.0.0.1:${PORT}`)
  console.log('等待前端连接...')
})
