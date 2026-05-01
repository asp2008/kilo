import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { saveConfig, loadConfig, listConfigs, deleteConfig } from '../utils/configManager'

export const useTaskStore = defineStore('task', () => {
  const tasks = ref([])
  const currentTask = ref(null)
  const executionLogs = ref([])

  // 加载所有任务
  async function loadTasks() {
    const configs = await listConfigs()
    tasks.value = configs
  }

  // 新建任务
  async function createTask(url, name) {
    const id = `task_${Date.now()}`
    const task = {
      id,
      name: name || `任务_${new Date().toLocaleString('zh-CN')}`,
      url,
      createdAt: new Date().toISOString(),
      status: 'pending', // pending | configured | running | done | error
      config: null,
    }
    tasks.value.unshift(task)
    await saveTask(task)
    return task
  }

  // 保存任务配置
  async function saveTask(task) {
    await saveConfig(task.id, task)
  }

  // 加载单个任务
  async function loadTask(id) {
    const data = await loadConfig(id)
    currentTask.value = data
    return data
  }

  // 删除任务
  async function removeTask(id) {
    await deleteConfig(id)
    tasks.value = tasks.value.filter(t => t.id !== id)
  }

  // 添加日志
  function addLog(taskId, level, message) {
    executionLogs.value.push({
      id: Date.now(),
      taskId,
      level, // info | warn | error | success
      message,
      timestamp: new Date().toISOString(),
    })
  }

  // 获取某任务日志
  function getTaskLogs(taskId) {
    return executionLogs.value.filter(l => l.taskId === taskId)
  }

  return {
    tasks,
    currentTask,
    executionLogs,
    loadTasks,
    createTask,
    saveTask,
    loadTask,
    removeTask,
    addLog,
    getTaskLogs,
  }
})
