/**
 * 自动填充执行器
 * 在 Tauri 环境中通过 WebView / 注入脚本填充表单
 * 浏览器开发模式下模拟执行流程
 */

import { recognizeCaptcha } from './formScraper'

/**
 * 执行自动填充任务
 * @param {Object} task - 任务配置
 * @param {Function} onLog - 日志回调 (level, message)
 * @param {Function} onCaptcha - 验证码回调 (imageDataUrl) => resolvedText
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

// ---- Tauri 执行模式（真实 WebView）----
async function executeTauri(task, log, onCaptcha) {
  // 这里调用 Tauri 后端命令，后端用 Rust + webview2 注入脚本
  try {
    const { invoke } = await import('@tauri-apps/api/tauri')
    log('info', '打开目标页面...')
    await invoke('open_url', { url: task.url })

    log('info', '等待页面加载...')
    await sleep(2000)

    for (const field of task.config?.fields || []) {
      if (!field.fillValue) continue
      log('info', `填充字段: ${field.label} (${field.key})`)

      if (field.isCaptcha) {
        log('info', '检测到验证码字段，尝试识别...')
        const captchaImg = await invoke('screenshot_captcha', { selector: field.selector })
        let captchaText = ''

        if (task.config?.captcha?.solver === 'manual') {
          captchaText = await onCaptcha?.(captchaImg) || ''
          log('info', `人工输入验证码: ${captchaText}`)
        } else {
          captchaText = await recognizeCaptcha(captchaImg)
          log('info', `OCR 识别验证码: ${captchaText}`)
        }

        await invoke('fill_field', { selector: field.selector, value: captchaText })
      } else {
        await invoke('fill_field', { selector: field.selector, value: field.fillValue })
      }
      await sleep(300)
    }

    if (task.config?.autoSubmit) {
      log('info', '自动提交表单...')
      await invoke('submit_form', { selector: task.config.submitSelector || 'form' })
      log('success', '表单已提交！')
    } else {
      log('info', '已填充完毕，等待手动提交。')
    }
  } catch (e) {
    log('error', `执行失败: ${e.message || e}`)
    throw e
  }
}

// ---- 浏览器模拟模式（开发调试）----
async function executeSimulate(task, log, onCaptcha) {
  log('info', '[模拟模式] 非 Tauri 环境，执行模拟填充流程')
  await sleep(500)

  for (const field of task.config?.fields || []) {
    await sleep(200)
    if (!field.fillValue) {
      log('warn', `字段 "${field.label}" 没有填充值，跳过`)
      continue
    }

    if (field.isCaptcha) {
      log('info', `[模拟] 验证码字段 "${field.label}" → 模拟 OCR 识别`)
      await sleep(800)
      log('info', `[模拟] 识别结果: AB12`)
    } else {
      log('info', `[模拟] 填充 "${field.label}" = "${field.fillValue}"`)
    }
  }

  await sleep(500)
  if (task.config?.autoSubmit) {
    log('success', '[模拟] 表单提交成功 ✓')
  } else {
    log('info', '[模拟] 填充完毕，未设置自动提交')
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
