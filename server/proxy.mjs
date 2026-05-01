/**
 * KiloForm 本地代理服务器
 * - GET  /api/proxy?url=...         → 抓取目标页面 HTML
 * - POST /api/submit                → 真实提交表单（application/x-www-form-urlencoded 或 multipart）
 * - GET  /api/captcha?url=...       → 下载验证码图片并以 base64 返回
 *
 * 启动：node server/proxy.mjs
 */

import express from 'express'
import cors from 'cors'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const fetch = (...args) => import('node-fetch').then(m => m.default(...args))
const FormData = (...args) => import('node-fetch').then(m => new m.FormData(...args))

const app = express()
const PORT = 3001

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ── 通用请求头 ──────────────────────────────────────────────────────────────
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36'

// ── GET /api/proxy ──────────────────────────────────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ error: '缺少 url 参数' })

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })

    const contentType = resp.headers.get('content-type') || 'text/html'
    const body = await resp.text()

    res.setHeader('Content-Type', contentType)
    res.setHeader('X-Final-Url', resp.url)
    res.status(resp.status).send(body)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// ── GET /api/captcha ────────────────────────────────────────────────────────
app.get('/api/captcha', async (req, res) => {
  const { url, referer } = req.query
  if (!url) return res.status(400).json({ error: '缺少 url 参数' })

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': referer || url,
        'Accept': 'image/*',
      },
      signal: AbortSignal.timeout(10000),
    })

    const buffer = await resp.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    const mime = resp.headers.get('content-type') || 'image/png'

    res.json({
      dataUrl: `data:${mime};base64,${base64}`,
      contentType: mime,
    })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// ── POST /api/submit ─────────────────────────────────────────────────────────
/**
 * Body:
 * {
 *   url: string,              // 表单 action URL
 *   method: 'POST'|'GET',
 *   fields: [{ key, fillValue, type }],
 *   referer: string,          // 来源页面 URL
 *   cookies: string,          // 可选 Cookie 字符串
 *   submitSelector: string,   // 不影响 HTTP 提交，仅记录
 * }
 */
app.post('/api/submit', async (req, res) => {
  const { url, method = 'POST', fields = [], referer, cookies } = req.body

  if (!url) return res.status(400).json({ error: '缺少 url' })

  // 构建表单数据
  const params = new URLSearchParams()
  for (const field of fields) {
    if (field.type === 'file') continue // file 类型跳过（需要 multipart，后续支持）
    const val = field.fillValue != null ? String(field.fillValue) : ''
    params.append(field.key, val)
  }

  const headers = {
    'User-Agent': DEFAULT_UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': referer || url,
    'Origin': new URL(url).origin,
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  if (cookies) headers['Cookie'] = cookies

  console.log(`[submit] ${method} ${url}`)
  console.log('[submit] fields:', params.toString())

  try {
    const fetchMethod = method.toUpperCase() === 'GET' ? 'GET' : 'POST'
    const fetchUrl = fetchMethod === 'GET'
      ? `${url}?${params.toString()}`
      : url

    const resp = await fetch(fetchUrl, {
      method: fetchMethod,
      headers,
      body: fetchMethod === 'POST' ? params.toString() : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })

    const responseText = await resp.text()
    const finalUrl = resp.url

    console.log(`[submit] response: ${resp.status} → ${finalUrl}`)

    res.json({
      ok: resp.status < 400,
      status: resp.status,
      finalUrl,
      responseText: responseText.slice(0, 5000), // 返回前 5000 字符用于调试
    })
  } catch (e) {
    console.error('[submit] error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// ── 健康检查 ─────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }))

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ KiloForm 代理服务器已启动: http://127.0.0.1:${PORT}`)
})
