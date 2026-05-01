<template>
  <div>
    <div class="page-header">
      <h2>▶️ 自动执行</h2>
      <p>加载配置，自动填充并提交表单</p>
    </div>

    <el-row :gutter="20">
      <!-- 左侧：任务选择 + 配置预览 -->
      <el-col :span="10">
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

          <div class="detail-item">
            <label>名称</label>
            <span>{{ task.name }}</span>
          </div>
          <div class="detail-item">
            <label>URL</label>
            <el-link :href="task.url" target="_blank" type="primary" class="url-text">{{ task.url }}</el-link>
          </div>
          <div class="detail-item">
            <label>字段数</label>
            <span>{{ task.config?.fields?.length || 0 }} 个</span>
          </div>
          <div class="detail-item">
            <label>验证码</label>
            <el-tag v-if="task.config?.captcha?.enabled" type="warning" size="small">
              {{ task.config.captcha.solver }}
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

          <!-- 填充值速览 -->
          <div v-for="field in task.config?.fields || []" :key="field.key" class="field-preview">
            <div class="field-label">
              {{ field.label || field.key }}
              <el-tag v-if="field.isCaptcha" type="warning" size="small">验证码</el-tag>
            </div>
            <div class="field-value">
              {{ field.isCaptcha ? '[自动识别]' : (field.fillValue || '(空)') }}
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 右侧：执行控制 + 日志 -->
      <el-col :span="14">
        <!-- 执行控制 -->
        <el-card class="mb-4">
          <template #header><span>执行控制</span></template>

          <div class="execute-controls">
            <el-button
              type="primary"
              size="large"
              :loading="running"
              :disabled="!task"
              @click="startExecution"
            >
              <el-icon><VideoPlay /></el-icon>
              {{ running ? '执行中...' : '开始执行' }}
            </el-button>
            <el-button
              v-if="running"
              type="danger"
              size="large"
              @click="stopExecution"
            >
              <el-icon><VideoPause /></el-icon> 停止
            </el-button>
            <el-button size="large" @click="clearLogs">
              <el-icon><Delete /></el-icon> 清空日志
            </el-button>
          </div>

          <!-- 进度条 -->
          <el-progress
            v-if="running || progress > 0"
            :percentage="progress"
            :status="progressStatus"
            style="margin-top: 16px"
          />
        </el-card>

        <!-- 验证码识别面板 -->
        <el-card v-if="captchaImageUrl" class="mb-4 captcha-card">
          <template #header>
            <div class="card-header">
              <span>🔐 验证码识别</span>
              <el-tag type="warning">需要人工输入</el-tag>
            </div>
          </template>
          <div class="captcha-panel">
            <img :src="captchaImageUrl" alt="captcha" class="captcha-img" />
            <div class="captcha-input-row">
              <el-input
                v-model="captchaInput"
                placeholder="输入验证码"
                style="flex: 1"
                @keyup.enter="submitCaptcha"
              />
              <el-button type="primary" @click="submitCaptcha">确认</el-button>
            </div>
          </div>
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
import { executeTask } from '../utils/autoFiller'
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
let captchaResolve = null
let stopped = false

const configuredTasks = computed(() =>
  taskStore.tasks.filter(t => t.status === 'configured' || t.status === 'done' || t.status === 'error')
)

onMounted(async () => {
  await taskStore.loadTasks()
  if (selectedTaskId.value) {
    await loadSelectedTask(selectedTaskId.value)
  }
})

async function loadSelectedTask(id) {
  task.value = await taskStore.loadTask(id)
}

function addLog(level, message) {
  logs.value.push({ id: Date.now() + Math.random(), level, message, timestamp: new Date().toISOString() })
  nextTick(() => {
    if (logPanel.value) logPanel.value.scrollTop = logPanel.value.scrollHeight
  })
}

async function startExecution() {
  if (!task.value) return
  running.value = true
  stopped = false
  progress.value = 0
  progressStatus.value = ''

  const fields = task.value.config?.fields || []
  const total = fields.length || 1

  try {
    await executeTask(
      task.value,
      (level, msg) => {
        addLog(level, msg)
        // 估算进度
        const infoCount = logs.value.filter(l => l.level === 'info').length
        progress.value = Math.min(Math.floor((infoCount / (total + 3)) * 100), 95)
      },
      async (imageDataUrl) => {
        // 验证码回调
        captchaImageUrl.value = imageDataUrl
        return new Promise((resolve) => {
          captchaResolve = resolve
        })
      }
    )

    if (!stopped) {
      progress.value = 100
      progressStatus.value = 'success'
      task.value.status = 'done'
      await taskStore.saveTask(task.value)
    }
  } catch (e) {
    addLog('error', `执行失败: ${e.message}`)
    progress.value = 100
    progressStatus.value = 'exception'
    task.value.status = 'error'
    await taskStore.saveTask(task.value)
  } finally {
    running.value = false
    captchaImageUrl.value = ''
  }
}

function stopExecution() {
  stopped = true
  running.value = false
  addLog('warn', '用户手动停止执行')
}

function submitCaptcha() {
  if (captchaResolve) {
    captchaResolve(captchaInput.value)
    captchaResolve = null
  }
  captchaInput.value = ''
  captchaImageUrl.value = ''
}

function clearLogs() {
  logs.value = []
  progress.value = 0
  progressStatus.value = ''
}

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

function statusType(s) {
  return { pending: 'info', configured: 'warning', running: '', done: 'success', error: 'danger' }[s] || 'info'
}

function statusLabel(s) {
  return { pending: '待配置', configured: '已配置', running: '执行中', done: '完成', error: '错误' }[s] || s
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('zh-CN')
}

function levelIcon(level) {
  return { info: 'ℹ', warn: '⚠', error: '✗', success: '✓' }[level] || '·'
}
</script>

<style scoped>
.mb-4 { margin-bottom: 16px; }
.card-header { display: flex; justify-content: space-between; align-items: center; }
.task-option { display: flex; justify-content: space-between; align-items: center; width: 100%; }
.detail-item { display: flex; align-items: center; margin-bottom: 10px; font-size: 14px; }
.detail-item label { width: 72px; color: #888; flex-shrink: 0; }
.url-text { font-size: 13px; word-break: break-all; }
.muted { color: #666; }

.field-preview {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid #2a2a4a;
  font-size: 13px;
}
.field-label { color: #aaa; }
.field-value { color: #fff; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.execute-controls { display: flex; gap: 12px; }

.log-panel {
  background: #0a0a1a;
  border-radius: 8px;
  padding: 12px;
  height: 320px;
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 13px;
}
.log-item { display: flex; gap: 8px; margin-bottom: 6px; align-items: flex-start; }
.log-time { color: #555; flex-shrink: 0; }
.log-icon { flex-shrink: 0; }
.log-msg { color: #ccc; word-break: break-all; }
.log-info .log-icon { color: #409eff; }
.log-warn .log-icon { color: #e6a23c; }
.log-warn .log-msg { color: #e6a23c; }
.log-error .log-icon { color: #f56c6c; }
.log-error .log-msg { color: #f56c6c; }
.log-success .log-icon { color: #67c23a; }
.log-success .log-msg { color: #67c23a; }
.log-empty { color: #555; text-align: center; padding: 40px 0; }

.captcha-card { border: 1px solid #e6a23c33 !important; }
.captcha-panel { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.captcha-img { border: 1px solid #3a3a5a; border-radius: 6px; max-height: 80px; }
.captcha-input-row { display: flex; gap: 8px; width: 100%; }
</style>
