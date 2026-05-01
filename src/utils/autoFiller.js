/**
 * 自动填充执行器
 * - Tauri 模式：在内嵌 WebView 窗口中通过 window.eval() 注入 JS 填充表单
 * - 浏览器模拟模式：打印日志，不真实填充（开发/演示用）
 */

import { recognizeCaptcha } from './formScraper'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 执行自动填充任务
 * @param {Object}   task       - 任务对象（含 task.config.fields）
 * @param {Function} onLog      - (level: 'info'|'warn'|'error'|'success', msg: string) => void
 * @param {Function} onCaptcha  - (imageDataUrl: string) => Promise<string>  手动验证码回调
 */
export async function executeTask(task, onLog, onCaptcha) {
  const log = (level, msg) => onLog?.(level, msg)
  log('info', `开始执行任务: ${task.name}`)
  log('info', `目标 URL: ${task.url}`)

  if (typeof window.__TAURI__ !== 'undefined') {
    await executeTauri(task, log, onCaptcha)
  } else {
    await executeSimulate(task, log, onCaptcha)
  }
}

// ─────────────────────────────────────────────
// Tauri 真实执行
// ─────────────────────────────────────────────
async function executeTauri(task, log, onCaptcha) {
  const { invoke } = await import('@tauri-apps/api/tauri')
  const { WebviewWindow } = await import('@tauri-apps/api/window')

  // 1. 创建/获取自动化 WebView 窗口
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

  // 等待窗口加载完成
  await new Promise((resolve, reject) => {
    const unlisten = win.once('tauri://load', resolve)
    setTimeout(resolve, 4000) // 超时兜底
  })
  log('info', '页面加载完成，开始填充...')
  await sleep(task.config?.delay ?? 500)

  // 2. 逐字段填充
  const fields = task.config?.fields || []
  for (const field of fields) {
    await sleep(200)

    if (field.isCaptcha) {
      // 先截图验证码
      log('info', `检测到验证码字段: ${field.label}`)
      const captchaDataUrl = await captureElement(win, field.selector)
      let captchaText = ''

      const solver = task.config?.captcha?.solver || 'tesseract'
      if (solver === 'manual') {
        captchaText = (await onCaptcha?.(captchaDataUrl)) || ''
        log('info', `人工输入验证码: "${captchaText}"`)
      } else {
        log('info', 'OCR 识别中...')
        captchaText = await recognizeCaptcha(captchaDataUrl)
        log('info', `OCR 结果: "${captchaText}"`)
      }

      if (captchaText) {
        await fillElement(win, field.selector, captchaText)
        log('success', `验证码已填入: "${captchaText}"`)
      } else {
        log('warn', '验证码识别失败，跳过')
      }
      continue
    }

    if (!field.fillValue && field.fillValue !== 0) {
      log('warn', `字段 "${field.label}" 无填充值，跳过`)
      continue
    }

    log('info', `填充 "${field.label}" = "${field.fillValue}"`)
    await fillElement(win, field.selector, String(field.fillValue))
    log('success', `"${field.label}" 填充完成`)
  }

  // 3. 自动提交
  if (task.config?.autoSubmit) {
    await sleep(300)
    log('info', '自动提交表单...')
    const submitSelector = task.config.submitSelector || 'button[type="submit"],input[type="submit"],[type="submit"]'
    const ok = await clickElement(win, submitSelector)
    if (ok) {
      log('success', '表单已提交！')
    } else {
      // fallback: submit() 直接调用
      await win.eval(`document.querySelector('form')?.submit()`)
      log('success', '表单已提交（fallback form.submit()）')
    }
  } else {
    log('info', '填充完毕，自动提交未开启。')
  }
}

// ─────────────────────────────────────────────
// WebView JS 注入辅助
// ─────────────────────────────────────────────

async function fillElement(win, selector, value) {
  const script = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, ${JSON.stringify(value)});
      } else {
        el.value = ${JSON.stringify(value)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `
  await win.eval(script)
}

async function clickElement(win, selector) {
  const script = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()
  `
  try {
    await win.eval(script)
    return true
  } catch {
    return false
  }
}

async function captureElement(win, selector) {
  // 获取验证码图片 src 或 canvas dataURL
  const script = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return '';
      // 如果验证码本身就是 img 标签
      if (el.tagName === 'IMG') return el.src;
      // 如果是 canvas
      if (el.tagName === 'CANVAS') return el.toDataURL();
      // 找附近的 img（常见：input 旁边有验证码图片）
      const parent = el.closest('.captcha,.verify-group,form') || el.parentElement;
      if (parent) {
        const img = parent.querySelector('img[src*="captcha"],img[src*="verify"],img[class*="captcha"],img');
        if (img) return img.src;
      }
      return '';
    })()
  `
  try {
    return await win.eval(script) || ''
  } catch {
    return ''
  }
}

// ─────────────────────────────────────────────
// 浏览器模拟模式（npm run dev 时）
// ─────────────────────────────────────────────
async function executeSimulate(task, log, onCaptcha) {
  log('info', '[模拟模式] 浏览器环境，执行模拟流程（不真实操作页面）')
  await sleep(400)

  const fields = task.config?.fields || []
  if (fields.length === 0) {
    log('warn', '没有配置任何字段，请先完成配置步骤')
    return
  }

  for (const field of fields) {
    await sleep(250)

    if (field.isCaptcha) {
      log('info', `[模拟] 验证码字段 "${field.label}" → 模拟 OCR 识别`)
      await sleep(600)
      const mockCode = Math.random().toString(36).slice(2, 6).toUpperCase()
      log('success', `[模拟] OCR 识别结果: "${mockCode}"`)
      log('info', `[模拟] 填入验证码: "${mockCode}"`)
      continue
    }

    if (!field.fillValue && field.fillValue !== 0) {
      log('warn', `字段 "${field.label}" (${field.key}) 没有填充值，跳过`)
      continue
    }

    log('info', `[模拟] 定位元素: ${field.selector}`)
    await sleep(150)
    log('success', `[模拟] 填充 "${field.label}" = "${field.fillValue}"`)
  }

  await sleep(300)
  if (task.config?.autoSubmit) {
    log('info', `[模拟] 点击提交按钮: ${task.config.submitSelector || 'button[type=submit]'}`)
    await sleep(400)
    log('success', '[模拟] 表单提交成功 ✓')
  } else {
    log('info', '[模拟] 填充完毕，自动提交未开启。')
  }
}
