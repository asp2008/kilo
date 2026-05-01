<template>
  <div>
    <div class="page-header">
      <h2>📋 任务管理</h2>
      <p>管理所有表单自动化任务，创建、配置、执行</p>
    </div>

    <!-- 操作栏 -->
    <el-card class="mb-4">
      <div class="toolbar">
        <el-button type="primary" @click="showCreateDialog = true">
          <el-icon><Plus /></el-icon> 新建任务
        </el-button>
        <el-button @click="handleImport">
          <el-icon><Upload /></el-icon> 导入配置
        </el-button>
        <el-input
          v-model="searchQuery"
          placeholder="搜索任务..."
          clearable
          style="width: 260px; margin-left: auto"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
      </div>
    </el-card>

    <!-- 任务列表 -->
    <el-card>
      <el-table :data="filteredTasks" stripe row-key="id" v-loading="loading">
        <el-table-column label="任务名称" min-width="160">
          <template #default="{ row }">
            <span class="task-name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="目标 URL" min-width="200">
          <template #default="{ row }">
            <el-link :href="row.url" target="_blank" type="primary">
              {{ truncate(row.url, 40) }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">
            {{ formatDate(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="goConfig(row)">
              <el-icon><Setting /></el-icon> 配置
            </el-button>
            <el-button size="small" type="success" @click="goExecute(row)">
              <el-icon><VideoPlay /></el-icon> 执行
            </el-button>
            <el-button size="small" @click="handleExport(row)">
              <el-icon><Download /></el-icon>
            </el-button>
            <el-popconfirm
              title="确认删除该任务？"
              @confirm="handleDelete(row.id)"
            >
              <template #reference>
                <el-button size="small" type="danger">
                  <el-icon><Delete /></el-icon>
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="!loading && filteredTasks.length === 0" class="empty-state">
        <el-empty description="暂无任务，点击「新建任务」开始">
          <el-button type="primary" @click="showCreateDialog = true">新建任务</el-button>
        </el-empty>
      </div>
    </el-card>

    <!-- 新建任务对话框 -->
    <el-dialog v-model="showCreateDialog" title="新建任务" width="500px" destroy-on-close>
      <el-form :model="newTask" :rules="rules" ref="formRef" label-width="80px">
        <el-form-item label="任务名称" prop="name">
          <el-input v-model="newTask.name" placeholder="例：登录表单自动化" />
        </el-form-item>
        <el-form-item label="目标 URL" prop="url">
          <el-input v-model="newTask.url" placeholder="https://example.com/form" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="handleCreate" :loading="creating">
          创建并配置
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTaskStore } from '../stores/taskStore'
import { exportConfigAsFile, importConfigFromFile } from '../utils/configManager'
import { ElMessage } from 'element-plus'

const router = useRouter()
const taskStore = useTaskStore()
const loading = ref(false)
const creating = ref(false)
const showCreateDialog = ref(false)
const searchQuery = ref('')
const formRef = ref()

const newTask = ref({ name: '', url: '' })

const rules = {
  name: [{ required: true, message: '请输入任务名称', trigger: 'blur' }],
  url: [
    { required: true, message: '请输入目标 URL', trigger: 'blur' },
    { type: 'url', message: '请输入合法 URL', trigger: 'blur' },
  ],
}

const filteredTasks = computed(() => {
  const q = searchQuery.value.toLowerCase()
  if (!q) return taskStore.tasks
  return taskStore.tasks.filter(t =>
    t.name.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)
  )
})

onMounted(async () => {
  loading.value = true
  await taskStore.loadTasks()
  loading.value = false
})

async function handleCreate() {
  await formRef.value.validate()
  creating.value = true
  try {
    const task = await taskStore.createTask(newTask.value.url, newTask.value.name)
    showCreateDialog.value = false
    newTask.value = { name: '', url: '' }
    router.push(`/config/${task.id}`)
  } finally {
    creating.value = false
  }
}

function goConfig(task) {
  router.push(`/config/${task.id}`)
}

function goExecute(task) {
  if (!task.config) {
    ElMessage.warning('请先完成配置再执行')
    return
  }
  router.push(`/execute/${task.id}`)
}

function handleExport(task) {
  exportConfigAsFile(task)
  ElMessage.success('配置已导出')
}

async function handleImport() {
  try {
    const data = await importConfigFromFile()
    await taskStore.saveTask(data)
    await taskStore.loadTasks()
    ElMessage.success('导入成功')
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function handleDelete(id) {
  await taskStore.removeTask(id)
  ElMessage.success('已删除')
}

function statusType(s) {
  return { pending: 'info', configured: 'warning', running: '', done: 'success', error: 'danger' }[s] || 'info'
}

function statusLabel(s) {
  return { pending: '待配置', configured: '已配置', running: '执行中', done: '完成', error: '错误' }[s] || s
}

function formatDate(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN')
}

function truncate(str, n) {
  return str?.length > n ? str.slice(0, n) + '…' : str
}
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.task-name { font-weight: 500; color: #fff; }
.mb-4 { margin-bottom: 16px; }
.empty-state { padding: 40px 0; }
</style>
