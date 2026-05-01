/**
 * Playwright 引擎 WebSocket 客户端
 * 连接 ws://127.0.0.1:3002，发送任务，接收日志/截图/验证码
 */

const WS_URL = 'ws://127.0.0.1:3002'

export function createPlaywrightRunner(onLog, onScreenshot, onCaptchaImage) {
  let ws = null
  let captchaResolve = null
  let doneResolve = null
  let doneReject = null

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(WS_URL)
      ws.onopen = () => resolve(ws)
      ws.onerror = (e) => reject(new Error('无法连接 Playwright 引擎，请运行: node server/playwright-engine.mjs'))
      ws.onmessage = (evt) => handleMessage(JSON.parse(evt.data))
    })
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'log':
        onLog?.(msg.level, msg.message, msg.timestamp)
        break
      case 'screenshot':
        onScreenshot?.(`data:image/jpeg;base64,${msg.data}`)
        break
      case 'captcha_image':
        onCaptchaImage?.(msg.data)
        // 等待用户输入通过 submitCaptcha() 回传
        break
      case 'done':
        if (msg.success) {
          doneResolve?.()
        } else {
          doneReject?.(new Error(msg.error || '执行失败'))
        }
        ws?.close()
        break
    }
  }

  async function run(task) {
    await connect()
    return new Promise((resolve, reject) => {
      doneResolve = resolve
      doneReject = reject
      ws.send(JSON.stringify({ type: 'run', task }))
    })
  }

  function submitCaptcha(value) {
    ws?.send(JSON.stringify({ type: 'captcha_reply', value }))
  }

  function stop() {
    ws?.send(JSON.stringify({ type: 'stop' }))
    ws?.close()
  }

  return { run, submitCaptcha, stop }
}

/** 检查引擎是否在线 */
export async function checkEngineOnline() {
  try {
    const resp = await fetch('http://127.0.0.1:3002/health', { signal: AbortSignal.timeout(2000) })
    return resp.ok
  } catch {
    return false
  }
}
