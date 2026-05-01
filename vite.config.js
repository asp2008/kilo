import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import enginePlugin from './vite-plugin-engine.js'

export default defineConfig({
  plugins: [vue(), enginePlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 开发模式代理，绕过跨域（生产用 Tauri 后端）
      '/api/proxy': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  // Tauri 构建配置
  build: {
    outDir: 'dist',
    target: 'esnext',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      external: [
        /^@tauri-apps\//,
      ],
    },
  },
})
