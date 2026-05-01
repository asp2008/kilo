/**
 * 自动填充执行器
 *
 * 执行模式：
 * 1. Tauri 模式     — 内嵌 WebView 注入 JS
 * 2. HTTP 提交模式  — 本地代理服务器真实 POST（推荐）
 * 3. 模拟降级模式   — 代理未启动时仅打印日志
 */

import { recognizeCaptcha } from './formScraper'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PROXY_BASE = 'http://127.0.0.1:3001'

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────
export async function executeTask(task, onLog, onCaptcha) {
  const log = (level, msg) => onLog?.(level, msg)
  log('info', `开始执行任务: ${task.name}`)
  log('info', `目标 URL: ${task.url}`)

  if (typeof window.__TAURI__ !== 'undefined') {
    await executeTauri(task, log, onCaptcha)
    return
  }

  const proxyOk = await checkProxy()
  if (proxyOk) {
    log('info', '已连接本地代理服务器，使用 HTTP 提交模式')
    await executeHTTP(task, log, onCaptcha)
  } else {
    log('warn', '本地代理服务器未启动，降级为模拟模式（不真实提交）')
    log('warn', '请在终端运行: node server/proxy.mjs')
    await executeSimulate(task, log)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 提交模式（核心）
// ─────────────────────────────────────────────────────────────────────────────
async function executeHTTP(task, log, onCaptcha) {
  // 1. 抓取表单页面，提取 action/method/hidden字段
  log('info', '正在抓取表单页面...')
  let formAction = task.url
  let formMethod = 'POST'
  let hiddenFields = []   // [{ key, value }]
  let pageCookies = ''    // Set-Cookie from page response

  try {
    const { html, cookies } = await fetchPageWithCookies(task.url)
    pageCookies = cookies

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const form = doc.querySelector('form')
    if (form) {
      const action = form.getAttribute('action')
      if (action) formAction = new URL(action, task.url).href
      formMethod = (form.getAttribute('method') || 'POST').toUpperCase()

      // ★ 提取所有 hidden 字段（这是之前缺失的关键步骤）
      form.querySelectorAll('input[type="hidden"]').forEach(el => {
        if (el.name) {
          hiddenFields.push({ key: el.name, value: el.value || '' })
        }
      })
      if (hiddenFields.length > 0) {
        log('info', `发现 ${hiddenFields.length} 个隐藏字段: ${hiddenFields.map(f => f.key).join(', ')}`)
      }
    }
  } catch (e) {
    log('warn', `页面解析失败，使用默认配置: ${e.message}`)
  }

  log('info', `提交地址: ${formAction} [${formMethod}]`)

  // 2. 去重用户配置字段
  const userFields = deduplicateFields(task.config?.fields || [])

  // 3. 处理验证码（在构建提交数据前，需要先填好验证码值）
  for (const field of userFields) {
    if (!field.isCaptcha) continue

    log('info', `处理验证码字段: "${field.label || field.key}"`)
    const captchaImgUrl = await findCaptchaImgUrl(task.url, field.selector)

    if (captchaImgUrl) {
      const dataUrl = await fetchCaptchaAsBase64(captchaImgUrl, task.url)
      const solver = task.config?.captcha?.solver || 'tesseract'

      if (solver === 'manual') {
        field.fillValue = (await onCaptcha?.(dataUrl)) || ''
        log('info', `人工输入验证码: "${field.fillValue}"`)
      } else {
        log('info', 'OCR 识别中...')
        field.fillValue = await recognizeCaptcha(dataUrl)
        log('info', `OCR 结果: "${field.fillValue}"`)
      }
    } else {
      log('warn', '未找到验证码图片，验证码字段将为空')
      field.fillValue = ''
    }
  }

  // 4. 合并字段：hidden 字段优先（保留原始值），用户字段覆盖同名 hidden 字段
  //    最终提交顺序：hidden fields + user fields（同 key 的以 user 为准）
  const hiddenMap = new Map(hiddenFields.map(f => [f.key, f.value]))
  const userMap   = new Map(userFields.map(f => [f.key, f]))

  // 构建最终字段列表
  const finalFields = []

  // 先放 hidden（用户没有配置的才用原始值）
  for (const { key, value } of hiddenFields) {
    if (!userMap.has(key)) {
      finalFields.push({ key, fillValue: value, type: 'hidden' })
    }
  }
  // 再放用户字段（file 类型跳过）
  for (const field of userFields) {
    if (field.type === 'file') {
      log('warn', `文件字段 "${field.label || field.key}" 暂不支持，跳过`)
      continue
    }
    finalFields.push(field)
  }

  // 5. 打印提交清单
  log('info', '─── 提交字段清单 ───')
  for (const f of finalFields) {
    const val = f.fillValue != null ? String(f.fillValue) : ''
    const tag = f.type === 'hidden' ? '[hidden]' : f.isCaptcha ? '[验证码]' : ''
    log('info', `  ${f.key} = "${val}" ${tag}`)
  }

  // 6. 发送提交请求
  log('info', '正在提交...')
  try {
    const resp = await fetch(`${PROXY_BASE}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: formAction,
        method: formMethod,
        fields: finalFields,
        referer: task.url,
        cookies: pageCookies,
      }),
    })

    const result = await resp.json()
    analyzeSubmitResult(result, log)
  } catch (e) {
    log('error', `提交请求失败: ${e.message}`)
    throw e
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 分析提交结果
// ─────────────────────────────────────────────────────────────────────────────
function analyzeSubmitResult(result, log) {
  if (!result.ok) {
    log('error', `提交失败，HTTP ${result.status}`)
    if (result.error) log('error', result.error)
    return
  }

  const html = result.responseText || ''
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  // 检查常见错误关键词（中/日/英）
  const errorPatterns = [
    /エラー|error|错误|失败|失敗|invalid|不正|不能|cannot|NG/i,
    /regikey|登録キー|注册密钥/i,
    /incorrect|wrong|mismatch/i,
    /spam|bot|captcha/i,
  ]
  const successPatterns = [
    /投稿しました|投稿完了|posted|success|成功|完了|ありがとう|thank/i,
    /書き込み.*完了|完成|registered/i,
  ]

  const foundError = errorPatterns.find(p => p.test(text))
  const foundSuccess = successPatterns.find(p => p.test(text))

  if (foundSuccess) {
    log('success', `✅ 提交成功！（页面确认: "${extractMatch(text, foundSuccess)}"）`)
    log('info', `最终 URL: ${result.finalUrl}`)
  } else if (foundError) {
    log('error', `⚠️ 服务端返回错误: "${extractMatch(text, foundError)}"`)
    log('error', `最终 URL: ${result.finalUrl}`)
    // 打印响应片段帮助调试
    const snippet = text.slice(0, 300)
    log('warn', `响应摘要: ${snippet}`)
  } else {
    // 不确定，打印 URL 和摘要
    log('info', `提交完成（HTTP ${result.status}），最终 URL: ${result.finalUrl}`)
    const snippet = text.slice(0, 200)
    log('info', `响应摘要: ${snippet}`)
  }
}

function extractMatch(text, pattern) {
  const m = text.match(pattern)
  if (!m) return ''
  const idx = text.indexOf(m[0])
  return text.slice(Math.max(0, idx - 20), idx + 60).trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri WebView 模式
// ─────────────────────────────────────────────────────────────────────────────
async function executeTauri(task, log, onCaptcha) {
  const { WebviewWindow } = await import('@tauri-apps/api/window')

  log('info', '打开目标页面...')
  let win = WebviewWindow.getByLabel('automation')
  if (!win) {
    win = new WebviewWindow('automation', {
      url: task.url,
      title: `KiloForm — ${task.name}`,
      width: 1200,
      height: 800,
    })
  } else {
    await win.navigate(task.url)
  }

  await new Promise(resolve => {
    const timer = setTimeout(resolve, 4000)
    win.once('tauri://load', () => { clearTimeout(timer); setTimeout(resolve, 500) })
  })
  log('info', '页面加载完成')
  await sleep(task.config?.delay ?? 500)

  const fields = deduplicateFields(task.config?.fields || [])

  for (const field of fields) {
    await sleep(200)
    if (field.isCaptcha) {
      const dataUrl = await captureElementDataUrl(win, field.selector)
      let captchaText = ''
      if (task.config?.captcha?.solver === 'manual') {
        captchaText = (await onCaptcha?.(dataUrl)) || ''
      } else {
        captchaText = await recognizeCaptcha(dataUrl)
        log('info', `OCR: "${captchaText}"`)
      }
      if (captchaText) await fillElement(win, field.selector, captchaText)
      continue
    }
    if (!field.fillValue && field.fillValue !== 0) continue
    log('info', `填充 "${field.label || field.key}" = "${field.fillValue}"`)
    await fillElement(win, field.selector, String(field.fillValue))
  }

  if (task.config?.autoSubmit) {
    await sleep(300)
    log('info', '点击提交...')
    const sel = task.config.submitSelector || 'button[type="submit"],input[type="submit"]'
    await win.eval(`(function(){const el=document.querySelector(${JSON.stringify(sel)});if(el)el.click();else document.querySelector('form')?.submit()})()`)
    log('success', '表单已提交！')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 模拟降级模式
// ─────────────────────────────────────────────────────────────────────────────
async function executeSimulate(task, log) {
  log('info', '[模拟] 演示流程（不真实提交）')
  const fields = deduplicateFields(task.config?.fields || [])
  for (const field of fields) {
    await sleep(200)
    if (field.isCaptcha) { log('info', `[模拟] 验证码字段 → OCR: "DEMO"`); continue }
    if (!field.fillValue && field.fillValue !== 0) { log('warn', `[模拟] "${field.label || field.key}" 无值，跳过`); continue }
    log('info', `[模拟] 填充 "${field.label || field.key}" = "${field.fillValue}"`)
  }
  await sleep(300)
  log('warn', '[模拟] 未真实提交 — 请启动代理后重新执行')
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

function deduplicateFields(fields) {
  const seen = new Set()
  return fields.filter(f => {
    if (seen.has(f.key)) return false
    seen.add(f.key)
    return true
  })
}

async function checkProxy() {
  try {
    const r = await fetch(`${PROXY_BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}

/** 抓取页面 HTML，同时返回 Set-Cookie 值（用于 session 维持） */
async function fetchPageWithCookies(url) {
  const resp = await fetch(
    `${PROXY_BASE}/api/proxy?url=${encodeURIComponent(url)}`,
    { signal: AbortSignal.timeout(12000) }
  )
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const html = await resp.text()
  const cookies = resp.headers.get('x-set-cookie') || ''
  return { html, cookies }
}

/** 从页面 DOM 找验证码图片的 URL */
async function findCaptchaImgUrl(pageUrl, inputSelector) {
  try {
    const { html } = await fetchPageWithCookies(pageUrl)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const input = doc.querySelector(inputSelector)
    if (!input) return null
    const root = input.closest('.captcha,.verify-group,form,.form-group,tr,td') || input.parentElement
    const img = root?.querySelector('img[src*="captcha"],img[src*="verify"],img[src*="code"],img[src*="check"],img')
    if (!img?.getAttribute('src')) return null
    return new URL(img.getAttribute('src'), pageUrl).href
  } catch { return null }
}

/** 通过代理下载验证码图片为 base64 dataURL */
async function fetchCaptchaAsBase64(imgUrl, referer) {
  try {
    const r = await fetch(`${PROXY_BASE}/api/captcha?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(referer)}`, { signal: AbortSignal.timeout(8000) })
    const { dataUrl } = await r.json()
    return dataUrl || ''
  } catch { return '' }
}

async function fillElement(win, selector, value) {
  await win.eval(`(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set||Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set;if(s)s.call(el,${JSON.stringify(value)});else el.value=${JSON.stringify(value)};['input','change'].forEach(e=>el.dispatchEvent(new Event(e,{bubbles:true})))})()`)
}

async function captureElementDataUrl(win, selector) {
  try {
    return await win.eval(`(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return'';if(el.tagName==='IMG')return el.src;if(el.tagName==='CANVAS')return el.toDataURL();const r=el.closest('.captcha,form,.form-group')||el.parentElement;if(r){const img=r.querySelector('img');if(img)return img.src;}return''})()`) || ''
  } catch { return '' }
}
