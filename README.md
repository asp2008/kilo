# KiloForm 🐉

> Tauri + Vue3 + Element Plus 桌面表单自动化框架

自动抓取网页表单、生成配置、自动填充并提交，支持验证码识别。

## 功能

| 模块 | 功能 |
|------|------|
| 任务管理 | 新建/删除/导入/导出任务配置 |
| 配置生成 | URL 抓取 → 表单解析 → 字段编辑 → 保存 JSON |
| 自动执行 | 加载配置 → 自动填充 → OCR/人工验证码 → 提交 |
| 日志面板 | 实时执行日志，支持级别过滤 |

## 技术栈

- **桌面框架**: Tauri 1.x (Rust 后端 + WebView 前端)
- **前端**: Vue 3 + Vite
- **UI 组件**: Element Plus (暗色主题)
- **状态管理**: Pinia
- **OCR**: Tesseract.js (本地，无需联网)
- **存储**: JSON 文件 (Tauri FS) / localStorage (浏览器开发)

## 快速开始

### 前置要求

```bash
# 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Linux 额外依赖
sudo apt install libwebkit2gtk-4.0-dev libgtk-3-dev libssl-dev pkg-config
```

### 安装 & 启动

```bash
npm install

# 开发模式 (浏览器, 无需 Rust)
npm run dev

# Tauri 桌面开发模式
npm run tauri:dev

# 构建桌面安装包
npm run tauri:build
```

## 配置文件格式

```json
{
  "id": "task_1234567890",
  "name": "登录表单",
  "url": "https://example.com/login",
  "status": "configured",
  "config": {
    "fields": [
      {
        "key": "username",
        "label": "用户名",
        "type": "text",
        "selector": "#username",
        "fillValue": "myuser",
        "isCaptcha": false
      },
      {
        "key": "captcha",
        "label": "验证码",
        "type": "text",
        "selector": "#captcha",
        "fillValue": "",
        "isCaptcha": true
      }
    ],
    "captcha": {
      "enabled": true,
      "solver": "tesseract"
    },
    "autoSubmit": true,
    "submitSelector": "button[type=\"submit\"]",
    "delay": 300
  }
}
```

## 验证码策略

| 方式 | 说明 |
|------|------|
| `tesseract` | 本地 OCR，适合简单数字/字母验证码 |
| `manual` | 弹出图片，人工输入 |
| `api` | 第三方打码 API（需配置 API Key）|

## 项目结构

```
src/
├── main.js                 # 应用入口
├── router/index.js         # 路由
├── stores/taskStore.js     # 任务状态 (Pinia)
├── utils/
│   ├── configManager.js    # 配置读写 (Tauri FS / localStorage)
│   ├── formScraper.js      # HTML 解析 + OCR
│   └── autoFiller.js       # 自动填充执行引擎
└── views/
    ├── TaskList.vue         # 任务列表
    ├── ConfigBuilder.vue    # 配置向导 (4步)
    ├── AutoExecute.vue      # 执行控制台
    └── Logs.vue             # 日志查看
src-tauri/
├── src/
│   ├── main.rs             # Tauri 入口
│   └── commands.rs         # Rust 后端命令
└── tauri.conf.json         # Tauri 配置
```

## License

MIT
