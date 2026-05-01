<template>
  <div>
    <div class="page-header">
      <h2>⚙️ 配置生成</h2>
      <p>抓取目标页面表单，生成并编辑填充配置</p>
    </div>

    <!-- 步骤指示 -->
    <el-steps :active="step" align-center class="steps-bar" finish-status="success">
      <el-step title="输入网址" />
      <el-step title="抓取表单" />
      <el-step title="编辑配置" />
      <el-step title="保存完成" />
    </el-steps>

    <!-- Step 0: URL 输入 -->
    <el-card v-if="step === 0" class="step-card">
      <h3>输入目标网址</h3>
      <el-form :model="form" label-width="90px" style="margin-top: 20px">
        <el-form-item label="任务名称">
          <el-input v-model="form.name" placeholder="例：注册表单" />
        </el-form-item>
        <el-form-item label="目标 URL">
          <el-input v-model="form.url" placeholder="https://example.com/register">
            <template #append>
              <el-button @click="startScrape" :loading="scraping">
                {{ scraping ? '抓取中...' : '抓取表单' }}
              </el-button>
            </template>
          </el-input>
        </el-form-item>
      </el-form>

      <el-alert v-if="scrapeError" :title="scrapeError" type="error" show-icon style="margin-top: 12px" />

      <div class="step-hint">
        <el-icon><InfoFilled /></el-icon>
        <span>抓取将解析页面 HTML，提取所有表单字段。动态渲染页面可能需要手动粘贴 HTML。</span>
      </div>

      <el-divider>或手动粘贴 HTML</el-divider>
      <el-input
        v-model="rawHtml"
        type="textarea"
        :rows="6"
        placeholder="粘贴目标页面 HTML..."
      />
      <el-button style="margin-top: 10px" @click="parseFromHtml" :disabled="!rawHtml">
        从 HTML 解析
      </el-button>
    </el-card>

    <!-- Step 1: 解析结果预览 -->
    <el-card v-if="step === 1" class="step-card">
      <div class="step-header">
        <h3>表单字段预览</h3>
        <div>
          <el-button size="small" @click="step = 0">← 返回</el-button>
          <el-button type="primary" size="small" @click="step = 2">下一步 →</el-button>
        </div>
      </div>

      <el-alert
        v-if="parsedFields.length === 0"
        title="未找到表单字段，请检查 HTML 或手动添加"
        type="warning"
        show-icon
      />

      <el-table :data="parsedFields" style="margin-top: 16px">
        <el-table-column label="字段名" prop="key" width="140" />
        <el-table-column label="标签" prop="label" width="130" />
        <el-table-column label="类型" prop="type" width="100" />
        <el-table-column label="隐藏" width="70">
          <template #default="{ row }">
            <el-tag v-if="row.type === 'hidden'" type="info" size="small">是</el-tag>
            <span v-else class="muted">否</span>
          </template>
        </el-table-column>
        <el-table-column label="验证码" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.isCaptcha" type="warning" size="small">是</el-tag>
            <span v-else class="muted">否</span>
          </template>
        </el-table-column>
        <el-table-column label="CSS 选择器" prop="selector" />
      </el-table>

      <div style="margin-top: 16px">
        <el-button @click="addField">+ 手动添加字段</el-button>
      </div>
    </el-card>

    <!-- Step 2: 编辑填充值 -->
    <el-card v-if="step === 2" class="step-card">
      <div class="step-header">
        <h3>编辑填充规则</h3>
        <div>
          <el-button size="small" @click="step = 1">← 返回</el-button>
          <el-button type="primary" size="small" @click="saveConfig">保存配置</el-button>
        </div>
      </div>

      <!-- 验证码设置 -->
      <el-collapse style="margin-bottom: 20px">
        <el-collapse-item title="🔐 验证码配置" name="captcha">
          <el-form :model="captchaConfig" label-width="120px">
            <el-form-item label="启用验证码">
              <el-switch v-model="captchaConfig.enabled" />
            </el-form-item>
            <el-form-item label="识别方式" v-if="captchaConfig.enabled">
              <el-radio-group v-model="captchaConfig.solver">
                <el-radio value="tesseract">本地 OCR (Tesseract)</el-radio>
                <el-radio value="manual">人工识别</el-radio>
                <el-radio value="api">第三方 API</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="API Key" v-if="captchaConfig.solver === 'api'">
              <el-input v-model="captchaConfig.apiKey" type="password" show-password />
            </el-form-item>
            <el-form-item label="验证码长度" v-if="captchaConfig.enabled">
              <el-input-number v-model="captchaConfig.captchaLength" :min="1" :max="10" />
              <span class="muted" style="margin-left:8px">OCR 结果不足此长度时转为人工输入</span>
            </el-form-item>
          </el-form>
        </el-collapse-item>

        <el-collapse-item title="🚀 执行设置" name="exec">
          <el-form label-width="130px">
            <el-form-item label="自动提交">
              <el-switch v-model="form.autoSubmit" />
              <span class="muted" style="margin-left: 8px">填完后自动点击提交按钮</span>
            </el-form-item>
            <el-form-item label="提交按钮" v-if="form.autoSubmit">
              <el-input v-model="form.submitSelector" placeholder="CSS 选择器，例：input[type=submit]" />
            </el-form-item>
            <el-form-item label="最大重试次数">
              <el-input-number v-model="form.maxAttempts" :min="1" :max="10" />
              <span class="muted" style="margin-left:8px">验证码失败后自动重试</span>
            </el-form-item>
            <el-form-item label="执行延迟 (ms)">
              <el-input-number v-model="form.delay" :min="0" :max="5000" :step="100" />
            </el-form-item>
          </el-form>
        </el-collapse-item>

        <el-collapse-item title="✅ 成功/失败关键词" name="keywords">
          <el-form label-width="130px">
            <el-form-item label="成功关键词">
              <el-select
                v-model="form.successKeywords"
                multiple
                filterable
                allow-create
                placeholder="输入后按 Enter 添加"
                style="width:100%"
              />
              <div class="muted" style="margin-top:4px;font-size:12px">页面包含任一关键词 → 判断为成功（留空则仅靠页面跳转判断）</div>
            </el-form-item>
            <el-form-item label="失败关键词">
              <el-select
                v-model="form.failureKeywords"
                multiple
                filterable
                allow-create
                placeholder="输入后按 Enter 添加"
                style="width:100%"
              />
              <div class="muted" style="margin-top:4px;font-size:12px">默认: エラー / error / もう一度 / 認証失敗 等</div>
            </el-form-item>
          </el-form>
        </el-collapse-item>
      </el-collapse>

      <!-- Hidden 字段提示 -->
      <el-alert
        v-if="hiddenFields.length > 0"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      >
        <template #title>
          发现 {{ hiddenFields.length }} 个隐藏字段（自动携带原始值）：{{ hiddenFields.map(f => f.key).join(', ') }}
        </template>
      </el-alert>

      <!-- 字段填充表（只显示非 hidden 字段）-->
      <h4 style="margin-bottom: 12px; color: #aaa">字段填充值</h4>
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="12" v-for="(field, idx) in visibleFields" :key="field.key">
            <el-form-item>
              <template #label>
                <span>{{ field.label || field.key }}</span>
                <el-tag v-if="field.isCaptcha" type="warning" size="small" style="margin-left: 6px">验证码</el-tag>
                <el-tag v-if="field.required" type="danger" size="small" style="margin-left: 4px">必填</el-tag>
              </template>
              <el-input
                v-if="field.type === 'textarea'"
                v-model="field.fillValue"
                type="textarea"
                :rows="3"
                :placeholder="field.placeholder || '填入值'"
              />
              <el-select
                v-else-if="field.type === 'select'"
                v-model="field.fillValue"
                style="width: 100%"
              >
                <el-option
                  v-for="opt in field.options"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
              <el-input
                v-else
                v-model="field.fillValue"
                :type="field.isCaptcha ? 'text' : field.type"
                :placeholder="field.isCaptcha ? '留空：执行时自动识别' : (field.placeholder || '填入值')"
              />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
    </el-card>

    <!-- Step 3: 保存完成 -->
    <el-card v-if="step === 3" class="step-card success-card">
      <el-result icon="success" title="配置已保存！">
        <template #sub-title>
          任务 <strong>{{ form.name }}</strong> 配置完成，可以开始自动执行了。
        </template>
        <template #extra>
          <el-button type="primary" @click="goExecute">立即执行</el-button>
          <el-button @click="router.push('/tasks')">返回列表</el-button>
          <el-button @click="handleExport">导出配置</el-button>
        </template>
      </el-result>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTaskStore } from '../stores/taskStore'
import { parseFormFields, fetchPageHTML } from '../utils/formScraper'
import { exportConfigAsFile } from '../utils/configManager'
import { ElMessage } from 'element-plus'

const route = useRoute()
const router = useRouter()
const taskStore = useTaskStore()

const step = ref(0)
const scraping = ref(false)
const scrapeError = ref('')
const rawHtml = ref('')
const parsedFields = ref([])

const form = ref({
  name: '',
  url: '',
  autoSubmit: false,
  submitSelector: 'input[type="submit"],button[type="submit"]',
  delay: 300,
  maxAttempts: 5,
  successKeywords: [],
  failureKeywords: [],
})

const captchaConfig = ref({
  enabled: false,
  solver: 'tesseract',
  apiKey: '',
  captchaLength: 4,
})

const taskId = route.params.id

// Hidden 字段（自动携带）
const hiddenFields = computed(() => parsedFields.value.filter(f => f.type === 'hidden'))
// 可见字段（用户可编辑）
const visibleFields = computed(() => parsedFields.value.filter(f => f.type !== 'hidden'))

onMounted(async () => {
  if (taskId) {
    const task = await taskStore.loadTask(taskId)
    if (task) {
      form.value.name = task.name
      form.value.url = task.url
      if (task.config) {
        parsedFields.value = task.config.fields || []
        captchaConfig.value = task.config.captcha || captchaConfig.value
        form.value.autoSubmit = task.config.autoSubmit || false
        form.value.submitSelector = task.config.submitSelector || form.value.submitSelector
        form.value.delay = task.config.delay || 300
        form.value.maxAttempts = task.config.maxAttempts || 5
        form.value.successKeywords = task.config.successKeywords || []
        form.value.failureKeywords = task.config.failureKeywords || []
        if (parsedFields.value.length) step.value = 2
      }
    }
  }
})

async function startScrape() {
  if (!form.value.url) {
    ElMessage.warning('请输入 URL')
    return
  }
  scraping.value = true
  scrapeError.value = ''
  try {
    const html = await fetchPageHTML(form.value.url)
    parsedFields.value = parseFormFields(html)
    step.value = 1
    if (parsedFields.value.length === 0) {
      ElMessage.warning('未找到表单字段，请手动粘贴 HTML 或添加字段')
    } else {
      ElMessage.success(`共找到 ${parsedFields.value.length} 个字段`)
    }
  } catch (e) {
    scrapeError.value = e.message
  } finally {
    scraping.value = false
  }
}

function parseFromHtml() {
  parsedFields.value = parseFormFields(rawHtml.value)
  step.value = 1
  ElMessage.success(`解析到 ${parsedFields.value.length} 个字段`)
}

function addField() {
  parsedFields.value.push({
    key: `field_${Date.now()}`,
    label: '新字段',
    type: 'text',
    required: false,
    placeholder: '',
    isCaptcha: false,
    selector: '',
    fillValue: '',
    options: [],
  })
}

async function saveConfig() {
  const task = (await taskStore.loadTask(taskId)) || {
    id: taskId,
    name: form.value.name,
    url: form.value.url,
    createdAt: new Date().toISOString(),
  }

  task.name = form.value.name
  task.url = form.value.url
  task.status = 'configured'
  task.config = {
    fields: parsedFields.value,
    captcha: captchaConfig.value,
    autoSubmit: form.value.autoSubmit,
    submitSelector: form.value.submitSelector,
    delay: form.value.delay,
    maxAttempts: form.value.maxAttempts,
    successKeywords: form.value.successKeywords,
    failureKeywords: form.value.failureKeywords,
    updatedAt: new Date().toISOString(),
  }

  await taskStore.saveTask(task)
  taskStore.currentTask = task

  // 同步到任务列表
  const idx = taskStore.tasks.findIndex(t => t.id === task.id)
  if (idx >= 0) taskStore.tasks[idx] = task
  else taskStore.tasks.unshift(task)

  step.value = 3
  ElMessage.success('配置保存成功！')
}

function goExecute() {
  router.push(`/execute/${taskId}`)
}

function handleExport() {
  if (taskStore.currentTask) {
    exportConfigAsFile(taskStore.currentTask)
  }
}
</script>

<style scoped>
.steps-bar { margin-bottom: 28px; }
.step-card { max-width: 860px; }
.step-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.step-header h3 { color: #fff; margin: 0; }
.step-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #888;
  font-size: 13px;
  margin-top: 14px;
}
.muted { color: #666; font-size: 13px; }
.success-card { text-align: center; padding: 20px 0; }
h3 { color: #fff; }
h4 { color: #aaa; }
</style>
