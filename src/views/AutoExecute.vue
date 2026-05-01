<template>
  <div>
    <div class="page-header">
      <h2>▶️ 自动执行</h2>
      <p>使用 Playwright 真实浏览器自动填充并提交表单</p>
    </div>

    <el-row :gutter="20">
      <!-- 左侧：任务选择 + 配置预览 -->
      <el-col :span="9">
        <!-- 引擎状态 -->
        <el-card class="mb-4 engine-status-card">
          <div class="engine-status">
            <div class="status-indicator" :class="engineStatus">
              <span class="dot"></span>
              <span>{{ engineStatusText }}</span>
            </div>
            <el-button size="small" @click="checkEngineStatus" :loading="engineChecking">
              刷新
            </el-button>
          </div>
          <div v-if="engineStatus === 'offline'" class="engine-hint">
            在终端运行：<code>npm run engine</code>
          </div>
        </el-card>

        <!-- 任务选择 -->
        <el-card class="mb-4">
          <template #header>
            <div class="card-header">
              <span>选择任务</span>
              <el-button size="small" @click="handleImportConfig">
                <el-icon><Upload /></el-icon> 导入
              </el-button>
            </div>
          </template>
          <el-select
            v-model="selectedTaskId"
            placeholder="选择任务..."
            filterable
            style="width: 100%"
            @change="loadSelectedTask"
          >
            <el-option
              v-for="t in configuredTasks"
              :key="t.id"
              :label="t.name"
              :value="t.id"
            >
              <div class="task-option">
                <span>{{ t.name }}</span>
                <el-tag :type="statusType(t.status)" size="small">{{ statusLabel(t.status) }}</el-tag>
              </div>
            </el-option>
          </el-select>
        </el-card>

        <!-- 任务详情 -->
        <el-card v-if="task">
          <template #header><span>任务详情</span></template>
          <div class="detail-item"><label>名称</label><span>{{ task.name }}</span></div>
          <div class="detail-item">
            <label>URL</label>
            <el-link :href="task.url" target="_blank" type="primary" class="url-text">{{ task.url }}</el-link>
          </div>
          <div class="detail-item"><label>字段数</label><span>{{ visibleFieldCount }} 个</span></div>
          <div class="detail-item">
            <label>验证码</label>
            <el-tag v-if="task.config?.captcha?.enabled" type="warning" size="small">
              {{ captchaSolverLabel }}
            </el-tag>
            <span v-else class="muted">未启用</span>
          </div>
          <div class="detail-item">
            <label>自动提交</label>
            <el-tag :type="task.config?.autoSubmit ? 'success' : 'info'" size="small">
              {{ task.config?.autoSubmit ? '是' : '否' }}
            </el-tag>
          </div>
          <el-divider />
          <div
            v-for="field in visibleFields"
            :key="field.key"
            class="field-preview"
          >
            <div class="field-label">
              {{ field.label || field.key }}
              <el-tag v-if="field.isCaptcha" type="warning" size="small">验证码</el-tag>
            </div>
            <div class="field-value">
              {{ field.isCaptcha ? '[执行时识别]' : (field.fillValue || '(空)') }}
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 右侧 -->
      <el-col :span="15">
        <!-- 执行控制 -->
        <el-card class="mb-4">
          <template #header><span>执行控制</span></template>
          <div class="execute-controls">
            <el-button
              type="primary"
              size="large"
              :loading="running"
              :disabled="!task || engineStatus === 'offline'"
              @click="startExecution"
            >
              <el-icon><VideoPlay /></el-icon>
              {{ running ? '执行中...' : '开始执行' }}
            </el-button>
            <el-button v-if="running" type="danger" size="large" @click="stopExecution">
              <el-icon><VideoPause /></el-icon> 停止
            </el-button>
            <el-button size="large" @click="clearAll">
              <el-icon><Delete /></el-icon> 清空
            </el-button>
          </div>
          <el-progress
            v-if="running || progress > 0"
            :percentage="progress"
            :status="progressStatus"
            style="margin-top: 16px"
          />
        </el-card>

        <!-- 验证码面板 -->
        <el-card v-if="captchaImageUrl" class="mb-4 captcha-card">
          <template #header>
            <div class="card-header">
              <span>🔐 请输入验证码</span>
              <el-tag type="warning">等待输入</el-tag>
            </div>
          </template>
          <div class="captcha-panel">
            <img :src="captchaImageUrl" alt="captcha" class="captcha-img" />
            <div class="captcha-input-row">
              <el-input
                v-model="captchaInput"
                placeholder="输入验证码后回车"
                autofocus
                style="flex: 1"
                @keyup.enter="submitCaptcha"
              />
              <el-button type="primary" @click="submitCaptcha">确认</el-button>
            </div>
          </div>
        </el-card>

        <!-- 截图预览 -->
        <el-card v-if="screenshotUrl" class="mb-4">
          <template #header>
            <div class="card-header">
              <span>📸 页面截图</span>
              <el-button size="small" @click="screenshotUrl = ''">关闭</el-button>
            </div>
          </template>
          <img :src="screenshotUrl" style="width: 100%; border-radius: 6px" />
        </el-card>

        <!-- 日志面板 -->
        <el-card>
          <template #header>
            <div class="card-header">
              <span>执行日志</span>
              <el-tag size="small">{{ logs.length }} 条</el-tag>
            </div>
          </template>
          <div class="log-panel" ref="logPanel">
            <div
              v-for="log in logs"
              :key="log.id"
              :class="['log-item', `log-${log.level}`]"
            >
              <span class="log-time">{{ formatTime(log.timestamp) }}</span>
              <span class="log-icon">{{ levelIcon(log.level) }}</span>
              <span class="log-msg">{{ log.message }}</span>
            </div>
            <div v-if="logs.length === 0" class="log-empty">暂无日志，点击「开始执行」</div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useTaskStore } from '../stores/taskStore'
import { createPlaywrightRunner, checkEngineOnline } from '../utils/playwrightClient'
import { importConfigFromFile } from '../utils/configManager'
import { ElMessage } from 'element-plus'

const route = useRoute()
const taskStore = useTaskStore()

const selectedTaskId = ref(route.params.id || '')
const task = ref(null)
const running = ref(false)
const progress = ref(0)
const progressStatus = ref('')
const logs = ref([])
const logPanel = ref()
const captchaImageUrl = ref('')
const captchaInput = ref('')
const screenshotUrl = ref('')
const engineStatus = ref('checking')   // checking | online | offline
const engineChecking = ref(false)

let runner = null

// ── computed ──────────────────────────────────────────────────────────────────
const configuredTasks = computed(() =>
  taskStore.tasks.filter(t => t.config?.fields?.length > 0)
)

const visibleFields = computed(() =>
  (task.value?.config?.fields || []).filter(f => f.type !== 'hidden')
)

const visibleFieldCount = computed(() => visibleFields.value.length)

const engineStatusText = computed(() => ({
  checking: '检测中...',
  online:   '✅ Playwright 引擎已连接',
  offline:  '❌ 引擎未启动',
}[engineStatus.value]))

const captchaSolverLabel = computed(() => ({
  tesseract: 'OCR 自动识别',
  manual: '人工输入',
  api: '第三方 API',
}[task.value?.config?.captcha?.solver] || '自动'))

// ── lifecycle ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  await taskStore.loadTasks()
  if (selectedTaskId.value) await loadSelectedTask(selectedTaskId.value)
  else if (configuredTasks.value.length > 0) {
    selectedTaskId.value = configuredTasks.value[0].id
    await loadSelectedTask(selectedTaskId.value)
  }
  checkEngineStatus()
})

async function loadSelectedTask(id) {
  task.value = await taskStore.loadTask(id)
}

// ── 引擎状态 ──────────────────────────────────────────────────────────────────
async function checkEngineStatus() {
  engineChecking.value = true
  engineStatus.value = 'checking'
  const ok = await checkEngineOnline()
  engineStatus.value = ok ? 'online' : 'offline'
  engineChecking.value = false
}

// ── 执行 ──────────────────────────────────────────────────────────────────────
async function startExecution() {
  if (!task.value) return
  running.value = true
  progress.value = 10
  progressStatus.value = ''
  captchaImageUrl.value = ''
  screenshotUrl.value = ''

  runner = createPlaywrightRunner(
    // onLog
    (level, message, timestamp) => {
      addLog(level, message, timestamp)
      // 更新进度估算
      if (level === 'info') progress.value = Math.min(progress.value + 5, 90)
      if (level === 'success') progress.value = 100
    },
    // onScreenshot
    (dataUrl) => {
      screenshotUrl.value = dataUrl
    },
    // onCaptchaImage
    (dataUrl) => {
      captchaImageUrl.value = dataUrl
    }
  )

  try {
    await runner.run(task.value)
    progress.value = 100
    progressStatus.value = 'success'
    task.value.status = 'done'
    await taskStore.saveTask(task.value)
  } catch (e) {
    addLog('error', e.message)
    progress.value = 100
    progressStatus.value = 'exception'
    task.value.status = 'error'
    await taskStore.saveTask(task.value)
  } finally {
    running.value = false
    captchaImageUrl.value = ''
    runner = null
  }
}

function stopExecution() {
  runner?.stop()
  running.value = false
  addLog('warn', '已停止执行')
}

function submitCaptcha() {
  runner?.submitCaptcha(captchaInput.value)
  addLog('info', `验证码已提交: "${captchaInput.value}"`)
  captchaInput.value = ''
  captchaImageUrl.value = ''
}

// ── 日志 ──────────────────────────────────────────────────────────────────────
function addLog(level, message, timestamp) {
  logs.value.push({
    id: Date.now() + Math.random(),
    level,
    message,
    timestamp: timestamp || new Date().toISOString(),
  })
  nextTick(() => {
    if (logPanel.value) logPanel.value.scrollTop = logPanel.value.scrollHeight
  })
}

function clearAll() {
  logs.value = []
  progress.value = 0
  progressStatus.value = ''
  screenshotUrl.value = ''
  captchaImageUrl.value = ''
}

// ── 导入 ──────────────────────────────────────────────────────────────────────
async function handleImportConfig() {
  try {
    const data = await importConfigFromFile()
    await taskStore.saveTask(data)
    await taskStore.loadTasks()
    task.value = data
    selectedTaskId.value = data.id
    ElMessage.success('导入成功')
  } catch (e) {
    ElMessage.error(e.message)
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────────
const statusType = s => ({ pending: 'info', configured: 'warning', running: '', done: 'success', error: 'danger' }[s] || 'info')
const statusLabel = s => ({ pending: '待配置', configured: '已配置', running: '执行中', done: '完成', error: '错误' }[s] || s)
const formatTime = iso => new Date(iso).toLocaleTimeString('zh-CN')
const levelIcon = l => ({ info: 'ℹ', warn: '⚠', error: '✗', success: '✓' }[l] || '·')
</script>

<style scoped>
.mb-4 { margin-bottom: 16px; }
.card-header { display: flex; justify-content: space-between; align-items: center; }
.task-option { display: flex; justify-content: space-between; align-items: center; width: 100%; }

/* 引擎状态 */
.engine-status-card { padding: 0; }
.engine-status { display: flex; justify-content: space-between; align-items: center; }
.status-indicator { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.status-indicator.online { color: #67c23a; }
.status-indicator.offline { color: #f56c6c; }
.status-indicator.checking { color: #909399; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }
.status-indicator.online .dot { animation: pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
.engine-hint { margin-top: 8px; font-size: 12px; color: #888; }
.engine-hint code { background: #0f0f23; padding: 2px 6px; border-radius: 4px; color: #409eff; }

/* 任务详情 */
.detail-item { display: flex; align-items: flex-start; margin-bottom: 10px; font-size: 14px; }
.detail-item label { width: 72px; color: #888; flex-shrink: 0; }
.url-text { font-size: 13px; word-break: break-all; }
.muted { color: #666; }
.field-preview { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #2a2a4a; font-size: 13px; }
.field-label { color: #aaa; }
.field-value { color: #fff; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 执行控制 */
.execute-controls { display: flex; gap: 12px; flex-wrap: wrap; }

/* 验证码 */
.captcha-card { border: 1px solid #e6a23c66 !important; }
.captcha-panel { display: flex; flex-direction: column; gap: 12px; }
.captcha-img { max-height: 100px; border: 1px solid #3a3a5a; border-radius: 6px; }
.captcha-input-row { display: flex; gap: 8px; }

/* 日志 */
.log-panel {
  background: #0a0a1a;
  border-radius: 8px;
  padding: 12px;
  height: 360px;
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 13px;
}
.log-item { display: flex; gap: 8px; margin-bottom: 5px; align-items: flex-start; }
.log-time { color: #555; flex-shrink: 0; min-width: 70px; }
.log-icon { flex-shrink: 0; width: 14px; }
.log-msg { color: #ccc; word-break: break-all; }
.log-info .log-icon { color: #409eff; }
.log-warn .log-icon, .log-warn .log-msg { color: #e6a23c; }
.log-error .log-icon, .log-error .log-msg { color: #f56c6c; }
.log-success .log-icon, .log-success .log-msg { color: #67c23a; }
.log-empty { color: #555; text-align: center; padding: 40px 0; }
</style>
