/**
 * Vite 插件：开发服务器启动时自动拉起 Playwright 引擎
 * 用户只需 `npm run dev`，无需单独启动引擎
 */
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import net from 'net'

const ENGINE_PORT = 3002

function isPortInUse(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(true))   // 端口被占用 = 引擎已运行
    server.once('listening', () => { server.close(); resolve(false) })
    server.listen(port, '127.0.0.1')
  })
}

export default function enginePlugin() {
  let engineProcess = null

  return {
    name: 'vite-plugin-playwright-engine',

    async configureServer(server) {
      // 如果引擎已经在跑就跳过
      const inUse = await isPortInUse(ENGINE_PORT)
      if (inUse) {
        console.log('\x1b[32m[engine] Playwright 引擎已运行 (port 3002)\x1b[0m')
        return
      }

      const enginePath = path.resolve(process.cwd(), 'server/playwright-engine.mjs')
      console.log('\x1b[36m[engine] 正在启动 Playwright 引擎...\x1b[0m')

      engineProcess = spawn(process.execPath, [enginePath], {
        stdio: 'pipe',
        env: { ...process.env },
      })

      engineProcess.stdout.on('data', d => {
        process.stdout.write(`\x1b[36m[engine] ${d}\x1b[0m`)
      })
      engineProcess.stderr.on('data', d => {
        process.stderr.write(`\x1b[33m[engine] ${d}\x1b[0m`)
      })
      engineProcess.on('exit', code => {
        if (code !== 0 && code !== null) {
          console.error(`\x1b[31m[engine] 引擎退出，code=${code}\x1b[0m`)
        }
      })

      // Vite 关闭时一起关掉引擎
      server.httpServer?.on('close', () => {
        if (engineProcess && !engineProcess.killed) {
          engineProcess.kill()
        }
      })
    },

    buildEnd() {
      if (engineProcess && !engineProcess.killed) {
        engineProcess.kill()
      }
    },
  }
}
