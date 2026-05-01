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

  // 处理 input
  container.querySelectorAll('input').forEach(el => {
    const type = el.type?.toLowerCase() || 'text'
    if (['submit', 'button', 'reset', 'image'].includes(type)) return
    // hidden 字段保留，用于提交时不遗漏 session/token
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
 * 优先级：Playwright 引擎 > Tauri 后端 > 手动提示
 */
export async function fetchPageHTML(url) {
  // 1. Tauri 环境：Rust 后端直接 fetch
  if (typeof window.__TAURI__ !== 'undefined') {
    try {
      const { invoke } = await import('@tauri-apps/api/tauri')
      return await invoke('fetch_page_html', { url })
    } catch (e) {
      throw new Error(`Tauri 抓取失败: ${e}`)
    }
  }

  // 2. Playwright 引擎（无 CORS，支持 JS 渲染页面）
  try {
    const resp = await fetch(
      `http://127.0.0.1:3002/fetch?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(25000) }
    )
    if (resp.ok) return resp.text()
    throw new Error(`HTTP ${resp.status}`)
  } catch (e) {
    throw new Error(
      `抓取失败: ${e.message}\n\n` +
      `请确认 Playwright 引擎已启动（npm run dev 会自动启动），\n` +
      `或手动粘贴页面 HTML。`
    )
  }
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
