<template>
  <div>
    <div class="page-header">
      <h2>📄 执行日志</h2>
      <p>所有任务的执行记录</p>
    </div>

    <el-card>
      <div class="toolbar">
        <el-select v-model="filterLevel" placeholder="日志级别" clearable style="width: 130px">
          <el-option label="全部" value="" />
          <el-option label="信息" value="info" />
          <el-option label="警告" value="warn" />
          <el-option label="错误" value="error" />
          <el-option label="成功" value="success" />
        </el-select>
        <el-input v-model="search" placeholder="搜索日志内容..." clearable style="width: 260px">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-button @click="taskStore.executionLogs = []" type="danger" plain style="margin-left: auto">
          <el-icon><Delete /></el-icon> 清空
        </el-button>
      </div>

      <div class="log-panel" style="margin-top: 16px">
        <div
          v-for="log in filteredLogs"
          :key="log.id"
          :class="['log-item', `log-${log.level}`]"
        >
          <span class="log-time">{{ formatDate(log.timestamp) }}</span>
          <el-tag :type="tagType(log.level)" size="small" style="width: 48px; text-align: center; flex-shrink: 0">
            {{ levelLabel(log.level) }}
          </el-tag>
          <span class="log-task">{{ getTaskName(log.taskId) }}</span>
          <span class="log-msg">{{ log.message }}</span>
        </div>

        <div v-if="filteredLogs.length === 0" class="log-empty">
          <el-empty description="暂无日志" />
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useTaskStore } from '../stores/taskStore'

const taskStore = useTaskStore()
const filterLevel = ref('')
const search = ref('')

const filteredLogs = computed(() => {
  let logs = [...taskStore.executionLogs].reverse()
  if (filterLevel.value) logs = logs.filter(l => l.level === filterLevel.value)
  if (search.value) logs = logs.filter(l => l.message.toLowerCase().includes(search.value.toLowerCase()))
  return logs
})

function getTaskName(taskId) {
  const task = taskStore.tasks.find(t => t.id === taskId)
  return task?.name || taskId
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('zh-CN')
}

function tagType(level) {
  return { info: '', warn: 'warning', error: 'danger', success: 'success' }[level] || ''
}

function levelLabel(level) {
  return { info: '信息', warn: '警告', error: '错误', success: '成功' }[level] || level
}
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.log-panel { background: #0a0a1a; border-radius: 8px; padding: 12px; min-height: 200px; }
.log-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-bottom: 1px solid #1a1a30;
  font-size: 13px;
}
.log-time { color: #555; flex-shrink: 0; width: 140px; }
.log-task { color: #888; flex-shrink: 0; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-msg { color: #ccc; word-break: break-all; }
.log-error .log-msg { color: #f56c6c; }
.log-success .log-msg { color: #67c23a; }
.log-warn .log-msg { color: #e6a23c; }
.log-empty { padding: 40px 0; }
</style>
