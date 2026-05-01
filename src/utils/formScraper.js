/**
 * 表单抓取器
 * 解析 HTML，提取表单字段信息
 */

const INPUT_TYPE_MAP = {
  text: 'text',
  email: 'email',
  password: 'password',
  number: 'number',
  tel: 'tel',
  url: 'url',
  date: 'date',
  time: 'time',
  datetime: 'datetime-local',
  textarea: 'textarea',
  select: 'select',
  checkbox: 'checkbox',
  radio: 'radio',
  hidden: 'hidden',
}

/**
 * 从 HTML 字符串解析表单字段
 */
export function parseFormFields(html) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const fields = []

  // 优先抓取 <form> 内，否则全局扫描
  const forms = doc.querySelectorAll('form')
  const container = forms.length > 0 ? forms[0] : doc.body

  // 处理 input —— 注意：传入 doc 供内部查找 label
  container.querySelectorAll('input').forEach(el => {
    const type = el.type?.toLowerCase() || 'text'
    if (['submit', 'button', 'reset', 'image', 'hidden'].includes(type)) return
    const field = buildField(el, type, doc)
    if (field) fields.push(field)
  })

  // 处理 textarea
  container.querySelectorAll('textarea').forEach(el => {
    const field = buildField(el, 'textarea', doc)
    if (field) fields.push(field)
  })

  // 处理 select
  container.querySelectorAll('select').forEach(el => {
    const options = Array.from(el.querySelectorAll('option')).map(o => ({
      value: o.value,
      label: o.textContent.trim(),
    }))
    const field = buildField(el, 'select', doc)
    if (field) {
      field.options = options
      fields.push(field)
    }
  })

  return fields
}

/**
 * @param {Element} el
 * @param {string} type
 * @param {Document} doc  ← 必须传入解析后的 doc，不能用全局 document
 */
function buildField(el, type, doc) {
  const name = el.name || el.id || el.getAttribute('data-name') || null
  if (!name) return null

  // 在解析后的 doc 里查找关联 label（修复：原来用了全局 document）
  let label = ''
  if (el.id && doc) {
    const labelEl = doc.querySelector(`label[for="${el.id}"]`)
    if (labelEl) label = labelEl.textContent.trim()
  }
  if (!label) label = el.placeholder || el.getAttribute('aria-label') || name

  const isCaptcha =
    /captcha|验证码|code|verify/i.test(name) ||
    /captcha|验证码/i.test(el.className || '') ||
    /captcha|验证码/i.test(el.id || '')

  return {
    key: name,
    label,
    type: INPUT_TYPE_MAP[type] || 'text',
    required: el.required || false,
    placeholder: el.placeholder || '',
    defaultValue: el.value || '',
    isCaptcha,
    selector: buildSelector(el),
    fillValue: '',
    options: [],
  }
}

function buildSelector(el) {
  if (el.id) return `#${CSS.escape ? CSS.escape(el.id) : el.id}`
  if (el.name) return `[name="${el.name}"]`
  return el.tagName.toLowerCase()
}

/**
 * 抓取目标 URL 的 HTML
 * - Tauri 环境：调用 Rust 后端命令（无跨域限制）
 * - 浏览器开发环境：走 allorigins.win CORS 代理，或本地代理
 */
export async function fetchPageHTML(url) {
  if (typeof window.__TAURI__ !== 'undefined') {
    // Tauri: 调用 Rust 后端 fetch，彻底无 CORS 限制
    try {
      const { invoke } = await import('@tauri-apps/api/tauri')
      return await invoke('fetch_page_html', { url })
    } catch (e) {
      throw new Error(`Tauri 抓取失败: ${e}`)
    }
  }

  // 浏览器模式：先尝试本地代理，再 fallback 到 allorigins
  const errors = []

  // 1. 本地 Vite 代理（npm run dev 时可用）
  try {
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`
    const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(5000) })
    if (resp.ok) return resp.text()
    errors.push(`本地代理 HTTP ${resp.status}`)
  } catch (e) {
    errors.push(`本地代理不可用: ${e.message}`)
  }

  // 2. allorigins.win 公共 CORS 代理
  try {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
    const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) })
    if (resp.ok) return resp.text()
    errors.push(`allorigins HTTP ${resp.status}`)
  } catch (e) {
    errors.push(`allorigins 失败: ${e.message}`)
  }

  // 3. corsproxy.io 备用
  try {
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`
    const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) })
    if (resp.ok) return resp.text()
    errors.push(`corsproxy HTTP ${resp.status}`)
  } catch (e) {
    errors.push(`corsproxy 失败: ${e.message}`)
  }

  throw new Error(`所有代理均失败:\n${errors.join('\n')}\n\n请手动粘贴页面 HTML。`)
}

/**
 * OCR 识别验证码 (Tesseract.js)
 */
export async function recognizeCaptcha(imageData) {
  if (!imageData) return ''
  try {
    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker('eng')
    await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' })
    const { data: { text } } = await worker.recognize(imageData)
    await worker.terminate()
    return text.trim().replace(/\s+/g, '')
  } catch (e) {
    console.error('OCR 失败:', e)
    return ''
  }
}
