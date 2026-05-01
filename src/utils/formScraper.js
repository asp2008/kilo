/**
 * 表单抓取器
 * 解析 HTML，提取表单字段信息
 */

// 字段类型映射
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
 * @param {string} html
 * @returns {Array} fields
 */
export function parseFormFields(html) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const fields = []

  // 优先抓取 <form> 内的字段，否则全局扫描
  const forms = doc.querySelectorAll('form')
  const container = forms.length > 0 ? forms[0] : doc.body

  // 处理 input
  container.querySelectorAll('input').forEach(el => {
    const type = el.type?.toLowerCase() || 'text'
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return
    if (type === 'hidden') return // 暂时跳过 hidden

    const field = buildField(el, type)
    if (field) fields.push(field)
  })

  // 处理 textarea
  container.querySelectorAll('textarea').forEach(el => {
    const field = buildField(el, 'textarea')
    if (field) fields.push(field)
  })

  // 处理 select
  container.querySelectorAll('select').forEach(el => {
    const options = Array.from(el.querySelectorAll('option')).map(o => ({
      value: o.value,
      label: o.textContent.trim(),
    }))
    const field = buildField(el, 'select')
    if (field) {
      field.options = options
      fields.push(field)
    }
  })

  return fields
}

function buildField(el, type) {
  const name = el.name || el.id || el.getAttribute('data-name') || null
  if (!name) return null

  // 寻找关联 label
  let label = ''
  if (el.id) {
    const labelEl = document.querySelector?.(`label[for="${el.id}"]`)
    if (labelEl) label = labelEl.textContent.trim()
  }
  if (!label) label = el.placeholder || el.getAttribute('aria-label') || name

  // 判断是否验证码
  const isCaptcha =
    /captcha|验证码|code|verify/i.test(name) ||
    /captcha|验证码/i.test(el.className) ||
    /captcha|验证码/i.test(el.id)

  return {
    key: name,
    label,
    type: INPUT_TYPE_MAP[type] || 'text',
    required: el.required || false,
    placeholder: el.placeholder || '',
    defaultValue: el.value || '',
    isCaptcha,
    selector: buildSelector(el),
    fillValue: '', // 用户后续填写
  }
}

function buildSelector(el) {
  if (el.id) return `#${el.id}`
  if (el.name) return `[name="${el.name}"]`
  return el.tagName.toLowerCase()
}

/**
 * 通过 fetch 抓取目标 URL 的 HTML（需后端代理）
 * 在 Tauri 中直接发起请求，浏览器中通过后端代理
 */
export async function fetchPageHTML(url) {
  // 在 Tauri 环境中，直接用 Tauri HTTP 插件
  if (typeof window.__TAURI__ !== 'undefined') {
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/api/http')
      const resp = await tauriFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KiloBot/1.0)' },
      })
      return resp.data
    } catch (e) {
      throw new Error(`抓取失败: ${e.message}`)
    }
  }

  // 浏览器环境 — 走代理（开发阶段）
  const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`
  const resp = await fetch(proxyUrl)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.text()
}

/**
 * 从截图/Canvas 数据识别验证码 (Tesseract)
 */
export async function recognizeCaptcha(imageData) {
  try {
    // 动态加载 Tesseract.js
    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker('eng')
    const { data: { text } } = await worker.recognize(imageData)
    await worker.terminate()
    return text.trim().replace(/\s/g, '')
  } catch (e) {
    console.error('OCR 失败:', e)
    return ''
  }
}
