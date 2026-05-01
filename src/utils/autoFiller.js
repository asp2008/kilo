/**
 * 自动填充执行器
 *
 * 三种执行模式：
 * 1. Tauri 模式        — 内嵌 WebView 注入 JS，真实操作页面
 * 2. HTTP 提交模式     — 通过本地代理服务器直接 POST，不开浏览器（最可靠）
 * 3. 浏览器模拟模式    — 代理不可用时的 fallback，仅打印日志
 */

import { recognizeCaptcha, fetchPageHTML } from './formScraper'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PROXY_BASE = 'http://127.0.0.1:3001'

/**
 * 执行自动填充任务
 * @param {Object}   task
 * @param {Function} onLog      (level, message) => void
 * @param {Function} onCaptcha  (imageDataUrl) => Promise<string>
 */
export async function executeTask(task, onLog, onCaptcha) {
  const log = (level, msg) => onLog?.(level, msg)
  log('info', `开始执行任务: ${task.name}`)
  log('info', `目标 URL: ${task.url}`)

  if (typeof window.__TAURI__ !== 'undefined') {
    await executeTauri(task, log, onCaptcha)
    return
  }

  // 检查本地代理是否可用
  const proxyOk = await checkProxy()
  if (proxyOk) {
    log('info', '已连接本地代理服务器，使用 HTTP 提交模式')
    await executeHTTP(task, log, onCaptcha)
  } else {
    log('warn', '本地代理服务器未启动（需运行 node server/proxy.mjs）')
    log('warn', '降级为模拟模式，不会真实提交')
    await executeSimulate(task, log, onCaptcha)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 模式一：HTTP 提交（通过本地代理，最可靠）
// ─────────────────────────────────────────────────────────────────────────────
async function executeHTTP(task, log, onCaptcha) {
  const fields = task.config?.fields || []
  const workingFields = deduplicateFields(fields)

  // 1. 处理验证码（如有）
  for (const field of workingFields) {
    if (!field.isCaptcha) continue

    log('info', `处理验证码字段: "${field.label}"`)

    // 尝试获取验证码图片
    const captchaImgUrl = await fetchCaptchaImageUrl(task.url, field.selector)
    let captchaText = ''

    if (captchaImgUrl) {
      const solver = task.config?.captcha?.solver || 'tesseract'
      if (solver === 'manual') {
        // 下载图片转 base64 后交给用户
        const dataUrl = await fetchCaptchaAsBase64(captchaImgUrl, task.url)
        captchaText = (await onCaptcha?.(dataUrl)) || ''
        log('info', `人工输入验证码: "${captchaText}"`)
      } else {
        // OCR
        log('info', 'OCR 识别验证码...')
        const dataUrl = await fetchCaptchaAsBase64(captchaImgUrl, task.url)
        captchaText = await recognizeCaptcha(dataUrl)
        log('info', `OCR 结果: "${captchaText}"`)
      }
    } else {
      log('warn', '未找到验证码图片，跳过验证码字段')
    }

    field.fillValue = captchaText
  }

  // 2. 确定表单 action URL 和 method
  let formAction = task.url
  let formMethod = 'POST'
  try {
    const html = await fetchPageHTMLViaProxy(task.url)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const form = doc.querySelector('form')
    if (form) {
      const action = form.getAttribute('action')
      if (action) {
        formAction = new URL(action, task.url).href
      }
      formMethod = (form.getAttribute('method') || 'POST').toUpperCase()
    }
  } catch (e) {
    log('warn', `无法解析表单 action，使用原始 URL: ${e.message}`)
  }

  log('info', `表单提交地址: ${formAction} [${formMethod}]`)

  // 3. 打印将填充的字段
  for (const field of workingFields) {
    if (field.type === 'file') {
      log('warn', `文件字段 "${field.label}" 暂不支持 HTTP 模式上传，跳过`)
      continue
    }
    if (!field.fillValue && field.fillValue !== 0 && !field.isCaptcha) {
      log('warn', `字段 "${field.label}" (${field.key}) 无填充值，将以空值提交`)
      continue
    }
    log('info', `字段 "${field.label}" = "${field.fillValue}"`)
  }

  // 4. 发送 HTTP 提交
  log('info', '提交表单...')
  try {
    const resp = await fetch(`${PROXY_BASE}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: formAction,
        method: formMethod,
        fields: workingFields,
        referer: task.url,
      }),
    })

    const result = await resp.json()
    if (result.ok) {
      log('success', `✅ 提交成功！最终 URL: ${result.finalUrl}`)
      if (result.responseText) {
        // 检查响应里是否有错误提示
        const errMatch = result.responseText.match(/<[^>]*(?:error|alert|warning)[^>]*>([^<]{5,100})/i)
        if (errMatch) {
          log('warn', `页面提示: ${errMatch[1].trim()}`)
        }
      }
    } else {
      log('error', `提交失败，HTTP ${result.status}`)
      if (result.error) log('error', result.error)
    }
  } catch (e) {
    log('error', `提交请求失败: ${e.message}`)
    throw e
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 模式二：Tauri WebView 注入
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

  // 等待页面加载
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
      log('info', `验证码字段: "${field.label}"`)
      const captchaDataUrl = await captureElementDataUrl(win, field.selector)
      let captchaText = ''
      const solver = task.config?.captcha?.solver || 'tesseract'
      if (solver === 'manual') {
        captchaText = (await onCaptcha?.(captchaDataUrl)) || ''
      } else {
        captchaText = await recognizeCaptcha(captchaDataUrl)
        log('info', `OCR: "${captchaText}"`)
      }
      if (captchaText) await fillElement(win, field.selector, captchaText)
      continue
    }

    if (!field.fillValue && field.fillValue !== 0) {
      log('warn', `"${field.label}" 无填充值，跳过`)
      continue
    }
    log('info', `填充 "${field.label}" = "${field.fillValue}"`)
    await fillElement(win, field.selector, String(field.fillValue))
    log('success', `"${field.label}" 完成`)
  }

  if (task.config?.autoSubmit) {
    await sleep(300)
    log('info', '点击提交...')
    const submitSel = task.config.submitSelector || 'button[type="submit"],input[type="submit"],[type="submit"]'
    await win.eval(`
      (function(){
        const el = document.querySelector(${JSON.stringify(submitSel)});
        if(el){ el.click(); return; }
        document.querySelector('form')?.submit();
      })()
    `)
    log('success', '表单已提交！')
  } else {
    log('info', '填充完毕，自动提交未开启。')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 模式三：纯模拟（降级 fallback）
// ─────────────────────────────────────────────────────────────────────────────
async function executeSimulate(task, log, onCaptcha) {
  log('info', '[模拟] 代理未启动，执行演示流程')
  log('warn', '[模拟] 请运行 node server/proxy.mjs 以启用真实提交')
  const fields = deduplicateFields(task.config?.fields || [])

  for (const field of fields) {
    await sleep(200)
    if (field.isCaptcha) {
      log('info', `[模拟] 验证码字段 "${field.label}"`)
      await sleep(400)
      log('info', '[模拟] OCR: "DEMO"')
      continue
    }
    if (!field.fillValue && field.fillValue !== 0) {
      log('warn', `[模拟] "${field.label}" 无填充值，跳过`)
      continue
    }
    log('info', `[模拟] 填充 "${field.label}" = "${field.fillValue}"`)
    await sleep(100)
  }
  await sleep(300)
  if (task.config?.autoSubmit) {
    log('warn', '[模拟] 未真实提交 — 启动代理服务器后重新执行')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

/** 去掉重复的 key（如多个相同 name 的 radio button 只保留第一个） */
function deduplicateFields(fields) {
  const seen = new Set()
  return fields.filter(f => {
    if (seen.has(f.key)) return false
    seen.add(f.key)
    return true
  })
}

/** 检查代理服务器是否可用 */
async function checkProxy() {
  try {
    const resp = await fetch(`${PROXY_BASE}/api/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return resp.ok
  } catch {
    return false
  }
}

/** 通过代理抓取页面 HTML */
async function fetchPageHTMLViaProxy(url) {
  const resp = await fetch(`${PROXY_BASE}/api/proxy?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.text()
}

/** 通过代理获取验证码图片的 URL（从页面 DOM 查找） */
async function fetchCaptchaImageUrl(pageUrl, captchaSelector) {
  try {
    const html = await fetchPageHTMLViaProxy(pageUrl)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // 找验证码输入框旁边的图片
    const input = doc.querySelector(captchaSelector)
    if (!input) return null

    const parent = input.closest('.captcha,.verify-group,form,.form-group,tr,td') || input.parentElement
    if (!parent) return null

    const img = parent.querySelector(
      'img[src*="captcha"],img[src*="verify"],img[src*="code"],img[src*="check"],img'
    )
    if (!img) return null

    const src = img.getAttribute('src')
    if (!src) return null

    return new URL(src, pageUrl).href
  } catch {
    return null
  }
}

/** 通过代理下载验证码图片并转为 base64 data URL */
async function fetchCaptchaAsBase64(imgUrl, referer) {
  try {
    const resp = await fetch(
      `${PROXY_BASE}/api/captcha?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(referer)}`,
      { signal: AbortSignal.timeout(8000) }
    )
    const { dataUrl } = await resp.json()
    return dataUrl || ''
  } catch {
    return ''
  }
}

/** Tauri WebView: 填充表单元素 */
async function fillElement(win, selector, value) {
  await win.eval(`
    (function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if(!el) return;
      const setter =
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set;
      if(setter) setter.call(el, ${JSON.stringify(value)});
      else el.value = ${JSON.stringify(value)};
      ['input','change'].forEach(e => el.dispatchEvent(new Event(e,{bubbles:true})));
    })()
  `)
}

/** Tauri WebView: 截取元素图片为 dataURL */
async function captureElementDataUrl(win, selector) {
  try {
    return await win.eval(`
      (function(){
        const el = document.querySelector(${JSON.stringify(selector)});
        if(!el) return '';
        if(el.tagName==='IMG') return el.src;
        if(el.tagName==='CANVAS') return el.toDataURL();
        const root = el.closest('.captcha,form,.form-group') || el.parentElement;
        if(root){ const img=root.querySelector('img'); if(img) return img.src; }
        return '';
      })()
    `) || ''
  } catch { return '' }
}
