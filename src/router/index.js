import { createRouter, createWebHashHistory } from 'vue-router'
import TaskList from '../views/TaskList.vue'
import ConfigBuilder from '../views/ConfigBuilder.vue'
import AutoExecute from '../views/AutoExecute.vue'
import Logs from '../views/Logs.vue'

const routes = [
  { path: '/', redirect: '/tasks' },
  { path: '/tasks', name: 'TaskList', component: TaskList },
  { path: '/config/:id?', name: 'ConfigBuilder', component: ConfigBuilder },
  { path: '/execute/:id?', name: 'AutoExecute', component: AutoExecute },
  { path: '/logs', name: 'Logs', component: Logs },
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
})
