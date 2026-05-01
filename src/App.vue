<template>
  <el-container class="app-container">
    <!-- 左侧侧边栏 -->
    <el-aside width="220px" class="sidebar">
      <div class="logo">
        <el-icon size="28" color="#409eff"><Connection /></el-icon>
        <span>KiloForm</span>
      </div>

      <el-menu
        :default-active="activeMenu"
        router
        class="sidebar-menu"
        background-color="#1a1a2e"
        text-color="#c0c4cc"
        active-text-color="#409eff"
      >
        <el-menu-item index="/tasks">
          <el-icon><List /></el-icon>
          <span>任务管理</span>
        </el-menu-item>
        <el-menu-item index="/config">
          <el-icon><Setting /></el-icon>
          <span>配置生成</span>
        </el-menu-item>
        <el-menu-item index="/execute">
          <el-icon><VideoPlay /></el-icon>
          <span>自动执行</span>
        </el-menu-item>
        <el-menu-item index="/logs">
          <el-icon><Document /></el-icon>
          <span>执行日志</span>
        </el-menu-item>
      </el-menu>

      <!-- 底部版本信息 -->
      <div class="sidebar-footer">
        <span>KiloForm v1.0.0</span>
      </div>
    </el-aside>

    <!-- 右侧内容区 -->
    <el-main class="main-content">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </el-main>
  </el-container>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const activeMenu = computed(() => {
  const path = route.path
  if (path.startsWith('/config')) return '/config'
  if (path.startsWith('/execute')) return '/execute'
  return path
})
</script>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0f0f23;
  color: #e0e0e0;
}

.app-container {
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  background: #1a1a2e;
  border-right: 1px solid #2a2a4a;
  display: flex;
  flex-direction: column;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px 16px;
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  border-bottom: 1px solid #2a2a4a;
  letter-spacing: 1px;
}

.sidebar-menu {
  border-right: none !important;
  flex: 1;
}

.sidebar-menu .el-menu-item {
  border-radius: 8px;
  margin: 4px 8px;
}

.sidebar-menu .el-menu-item.is-active {
  background: rgba(64, 158, 255, 0.15) !important;
}

.sidebar-footer {
  padding: 12px 16px;
  font-size: 12px;
  color: #555;
  border-top: 1px solid #2a2a4a;
}

.main-content {
  background: #0f0f23;
  overflow-y: auto;
  padding: 24px;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}

/* 全局 Element Plus 暗色覆盖 */
.el-card {
  background: #1a1a2e !important;
  border-color: #2a2a4a !important;
  color: #e0e0e0 !important;
}

.el-card .el-card__header {
  border-bottom-color: #2a2a4a !important;
  color: #fff !important;
}

.el-input__wrapper {
  background: #0f0f23 !important;
  box-shadow: 0 0 0 1px #3a3a5a inset !important;
}

.el-input__inner {
  color: #e0e0e0 !important;
}

.el-table {
  background: #1a1a2e !important;
  color: #e0e0e0 !important;
}

.el-table th.el-table__cell {
  background: #16213e !important;
  color: #a0a0c0 !important;
}

.el-table tr {
  background: #1a1a2e !important;
}

.el-table--striped .el-table__body tr.el-table__row--striped td.el-table__cell {
  background: #1e1e38 !important;
}

.el-table td.el-table__cell {
  border-bottom-color: #2a2a4a !important;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h2 {
  font-size: 22px;
  font-weight: 600;
  color: #fff;
  margin-bottom: 6px;
}

.page-header p {
  color: #888;
  font-size: 14px;
}
</style>
