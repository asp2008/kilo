/**
 * 自动填充执行器
 *
 * 执行模式：
 * 1. Tauri 模式     — 内嵌 WebView 注入 JS
 * 2. HTTP 提交模式  — 本地代理服务器真实 POST
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
// HTTP 提交模式
// ─────────────────────────────────────────────────────────────────────────────
async function executeHTTP(task, log, onCaptcha) {
  // 1. 抓取表单页面，获取 action/method/hidden 字段
  log('info', '正在抓取表单页面...')
  let formAction = task.url
  let formMethod = 'POST'
  let hiddenFields = []
  let pageCookies = ''
  let pageHtml = ''

  try {
    const { html, cookies } = await fetchPageWithCookies(task.url)
    pageHtml = html
    pageCookies = cookies

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const form = doc.querySelector('form')
    if (form) {
      const action = form.getAttribute('action')
      if (action) formAction = new URL(action, task.url).href
      formMethod = (form.getAttribute('method') || 'POST').toUpperCase()

      form.querySelectorAll('input[type="hidden"]').forEach(el => {
        if (el.name) hiddenFields.push({ key: el.name, value: el.value || '' })
      })
      if (hiddenFields.length > 0) {
        log('info', `发现 ${hiddenFields.length} 个隐藏字段: ${hiddenFields.map(f => `${f.key}="${f.value}"`).join(', ')}`)
      }
    }
  } catch (e) {
    log('warn', `页面解析失败，使用默认配置: ${e.message}`)
  }

  log('info', `提交地址: ${formAction} [${formMethod}]`)

  // 2. 处理验证码字段
  const userFields = deduplicateFields(task.config?.fields || [])

  for (const field of userFields) {
    if (!field.isCaptcha) continue

    log('info', `处理验证码字段: "${field.label || field.key}"`)

    // 先在页面里找验证码图片
    const captchaImgUrl = findCaptchaImgInHtml(pageHtml, task.url, field.selector)

    if (captchaImgUrl) {
      log('info', `找到验证码图片: ${captchaImgUrl}`)
      const dataUrl = await fetchCaptchaAsBase64(captchaImgUrl, task.url)

      if (!dataUrl) {
        log('warn', '验证码图片下载失败，转为人工输入')
        field.fillValue = (await onCaptcha?.('')) || ''
      } else {
        const solver = task.config?.captcha?.solver || 'tesseract'
        if (solver === 'manual') {
          field.fillValue = (await onCaptcha?.(dataUrl)) || ''
          log('info', `人工输入验证码: "${field.fillValue}"`)
        } else {
          log('info', 'OCR 识别中...')
          const ocrResult = await recognizeCaptcha(dataUrl)
          log('info', `OCR 结果: "${ocrResult}"`)

          if (ocrResult) {
            field.fillValue = ocrResult
          } else {
            // ★ OCR 失败 → 自动回退到人工输入
            log('warn', 'OCR 识别失败，自动转为人工输入模式')
            field.fillValue = (await onCaptcha?.(dataUrl)) || ''
            log('info', `人工输入验证码: "${field.fillValue}"`)
          }
        }
      }
    } else {
      // ★ 找不到图片 → 人工输入（传空 dataUrl 让面板显示提示）
      log('warn', '未在页面中找到验证码图片，请人工输入')
      field.fillValue = (await onCaptcha?.('')) || ''
      log('info', `人工输入验证码: "${field.fillValue}"`)
    }
  }

  // 3. 合并字段：hidden 字段保留原始值，用户字段覆盖同名 hidden
  const userMap = new Map(userFields.map(f => [f.key, f]))
  const finalFields = []

  // 先放不被用户字段覆盖的 hidden
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

  // 4. 打印提交清单
  log('info', '─── 提交字段清单 ───')
  for (const f of finalFields) {
    const val = f.fillValue != null ? String(f.fillValue) : ''
    const tag = f.type === 'hidden' ? ' [hidden]' : f.isCaptcha ? ' [验证码]' : ''
    if (!val && f.type !== 'hidden') {
      log('warn', `  ${f.key} = "" ← 空值`)
    } else {
      log('info', `  ${f.key} = "${val.slice(0, 60)}"${tag}`)
    }
  }

  // 5. 提交
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
    analyzeSubmitResult(result, log, task.url)
  } catch (e) {
    log('error', `提交请求失败: ${e.message}`)
    throw e
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 结果分析（不再轻易报"成功"）
// ─────────────────────────────────────────────────────────────────────────────
function analyzeSubmitResult(result, log, originalUrl) {
  if (!result.ok) {
    log('error', `提交失败，HTTP ${result.status}`)
    if (result.error) log('error', result.error)
    return
  }

  const html = result.responseText || ''
  // 去除 HTML 标签，提取纯文本
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                   .replace(/<style[\s\S]*?<\/style>/gi, '')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ')
                   .trim()

  // 判断是否跳转了（和原 URL 不同通常说明处理成功）
  const redirected = result.finalUrl && result.finalUrl !== originalUrl

  // 明确成功关键词（中/日/英）
  const successPatterns = [
    /投稿しました|投稿完了|書き込み.*完了|送信.*完了|登録.*完了/,
    /success|posted|registered|完成|成功|ありがとうございました/i,
    /記事が投稿|コメントが送信|メッセージが/,
  ]
  // 明确失败关键词
  const errorPatterns = [
    /エラー|error|错误|失敗|失败|invalid|不正|incorrec|NG\b/i,
    /認証.*失敗|captcha.*wrong|画像認証|入力.*間違/,
    /regikey|登録キー|スパム|spam/i,
    /もう一度|再入力|やり直|try again/i,
  ]

  const foundSuccess = successPatterns.find(p => p.test(text))
  const foundError = errorPatterns.find(p => p.test(text))

  // 提取响应文本摘要（前 400 字）
  const snippet = text.slice(0, 400)

  if (foundSuccess && !foundError) {
    log('success', `✅ 提交成功！`)
    if (redirected) log('success', `跳转到: ${result.finalUrl}`)
    log('info', `页面内容: ${snippet}`)
  } else if (foundError) {
    log('error', `❌ 服务端返回错误！`)
    log('error', `最终 URL: ${result.finalUrl}`)
    log('warn', `页面内容: ${snippet}`)
  } else if (redirected) {
    // 有跳转但无法判断，大概率成功
    log('success', `✅ 提交完成，页面已跳转到: ${result.finalUrl}`)
    log('info', `响应摘要: ${snippet}`)
  } else {
    // 无法判断
    log('warn', `⚠️ 提交完成，但无法确认结果（HTTP ${result.status}）`)
    log('warn', `最终 URL: ${result.finalUrl}`)
    log('warn', `响应内容（前400字）: ${snippet}`)
  }
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
        if (!captchaText) captchaText = (await onCaptcha?.(dataUrl)) || ''
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
// 模拟降级
// ─────────────────────────────────────────────────────────────────────────────
async function executeSimulate(task, log) {
  log('info', '[模拟] 演示流程（不真实提交）')
  const fields = deduplicateFields(task.config?.fields || [])
  for (const field of fields) {
    await sleep(200)
    if (field.isCaptcha) { log('info', `[模拟] 验证码字段`); continue }
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
  return fields.filter(f => { if (seen.has(f.key)) return false; seen.add(f.key); return true })
}

async function checkProxy() {
  try {
    const r = await fetch(`${PROXY_BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}

async function fetchPageWithCookies(url) {
  const resp = await fetch(`${PROXY_BASE}/api/proxy?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(12000) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const html = await resp.text()
  const cookies = resp.headers.get('x-set-cookie') || ''
  return { html, cookies }
}

/**
 * 在已有 HTML 字符串中找验证码图片 URL
 * 不再重复请求页面，直接用已抓取的 HTML
 */
function findCaptchaImgInHtml(html, baseUrl, inputSelector) {
  if (!html) return null
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // 1. 用选择器找输入框旁的图片
    const input = doc.querySelector(inputSelector)
    if (input) {
      const root = input.closest('.captcha,.verify-group,form,.form-group,tr,td') || input.parentElement
      if (root) {
        const img = root.querySelector(
          'img[src*="captcha"],img[src*="verify"],img[src*="code"],img[src*="check"],img[src*="kana"],img[src*="num"]'
        )
        if (img?.getAttribute('src')) {
          return new URL(img.getAttribute('src'), baseUrl).href
        }
        // 任意 img（如只有一张图片在表单里）
        const anyImg = root.querySelector('img')
        if (anyImg?.getAttribute('src')) {
          return new URL(anyImg.getAttribute('src'), baseUrl).href
        }
      }
    }

    // 2. 全局搜索常见验证码图片
    const allImgs = doc.querySelectorAll('img')
    for (const img of allImgs) {
      const src = img.getAttribute('src') || ''
      if (/captcha|verify|code|kana|check|num|secur/i.test(src)) {
        return new URL(src, baseUrl).href
      }
    }

    // 3. 找 img 标签的 alt/class/id 含验证码关键字
    for (const img of allImgs) {
      const alt = img.getAttribute('alt') || ''
      const cls = img.className || ''
      const id = img.id || ''
      if (/captcha|verify|認証|验证/i.test(alt + cls + id)) {
        const src = img.getAttribute('src')
        if (src) return new URL(src, baseUrl).href
      }
    }

    return null
  } catch { return null }
}

async function fetchCaptchaAsBase64(imgUrl, referer) {
  try {
    const r = await fetch(
      `${PROXY_BASE}/api/captcha?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(referer)}`,
      { signal: AbortSignal.timeout(8000) }
    )
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
