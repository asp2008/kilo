/**
 * 配置文件管理器
 * 在浏览器环境使用 localStorage，在 Tauri 环境使用文件系统
 */

const isTauri = () => typeof window.__TAURI__ !== 'undefined'

// ---- Tauri 文件系统 API ----
async function tauriSave(id, data) {
  const { writeTextFile, BaseDirectory } = await import('@tauri-apps/api/fs')
  const { appDataDir } = await import('@tauri-apps/api/path')
  const dir = await appDataDir()
  await writeTextFile(`${dir}/configs/${id}.json`, JSON.stringify(data, null, 2))
}

async function tauriLoad(id) {
  const { readTextFile, BaseDirectory } = await import('@tauri-apps/api/fs')
  const { appDataDir } = await import('@tauri-apps/api/path')
  const dir = await appDataDir()
  try {
    const text = await readTextFile(`${dir}/configs/${id}.json`)
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function tauriList() {
  const { readDir } = await import('@tauri-apps/api/fs')
  const { appDataDir } = await import('@tauri-apps/api/path')
  const dir = await appDataDir()
  try {
    const entries = await readDir(`${dir}/configs`)
    const results = []
    for (const e of entries) {
      if (e.name?.endsWith('.json')) {
        const id = e.name.replace('.json', '')
        const data = await tauriLoad(id)
        if (data) results.push(data)
      }
    }
    return results
  } catch {
    return []
  }
}

async function tauriDelete(id) {
  const { removeFile } = await import('@tauri-apps/api/fs')
  const { appDataDir } = await import('@tauri-apps/api/path')
  const dir = await appDataDir()
  await removeFile(`${dir}/configs/${id}.json`)
}

// ---- localStorage fallback ----
const LS_PREFIX = 'kilo_config_'

function lsSave(id, data) {
  localStorage.setItem(LS_PREFIX + id, JSON.stringify(data))
  // 维护索引
  const index = JSON.parse(localStorage.getItem(LS_PREFIX + '__index') || '[]')
  if (!index.includes(id)) {
    index.push(id)
    localStorage.setItem(LS_PREFIX + '__index', JSON.stringify(index))
  }
}

function lsLoad(id) {
  const raw = localStorage.getItem(LS_PREFIX + id)
  return raw ? JSON.parse(raw) : null
}

function lsList() {
  const index = JSON.parse(localStorage.getItem(LS_PREFIX + '__index') || '[]')
  return index.map(id => lsLoad(id)).filter(Boolean)
}

function lsDelete(id) {
  localStorage.removeItem(LS_PREFIX + id)
  const index = JSON.parse(localStorage.getItem(LS_PREFIX + '__index') || '[]')
  localStorage.setItem(LS_PREFIX + '__index', JSON.stringify(index.filter(i => i !== id)))
}

// ---- 导出统一 API ----
export async function saveConfig(id, data) {
  if (isTauri()) return tauriSave(id, data)
  return lsSave(id, data)
}

export async function loadConfig(id) {
  if (isTauri()) return tauriLoad(id)
  return lsLoad(id)
}

export async function listConfigs() {
  if (isTauri()) return tauriList()
  return lsList()
}

export async function deleteConfig(id) {
  if (isTauri()) return tauriDelete(id)
  return lsDelete(id)
}

// 导出 JSON 文件
export function exportConfigAsFile(task) {
  const blob = new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${task.name || task.id}_${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// 从文件导入 JSON
export function importConfigFromFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = e => {
      const file = e.target.files[0]
      if (!file) return reject(new Error('未选择文件'))
      const reader = new FileReader()
      reader.onload = ev => {
        try {
          resolve(JSON.parse(ev.target.result))
        } catch {
          reject(new Error('JSON 格式错误'))
        }
      }
      reader.readAsText(file)
    }
    input.click()
  })
}
