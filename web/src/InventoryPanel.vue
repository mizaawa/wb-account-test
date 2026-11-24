<script setup>
import { computed, ref, watch } from 'vue'
const props = defineProps({ rows: { type: Array, required: true }, pageSize: { type: Number, required: true } })
const page = ref(1)
const pages = computed(() => Math.max(1, Math.ceil(props.rows.length / props.pageSize)))
const visible = computed(() => props.rows.slice((page.value - 1) * props.pageSize, page.value * props.pageSize))
watch(() => props.rows, () => { page.value = 1 })
const fmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
</script>
<template>
  <section class="inventory" aria-labelledby="inventory-heading">
    <h3 id="inventory-heading">WBProxyCenter 本地清单 <span>{{ rows.length.toLocaleString() }} 条</span></h3>
    <p>以下记录没有 accessToken，仅展示导出信息，不能测活。请导入包含令牌的完整导出；带凭证的账号会显示在下方测活列表。</p>
    <ul class="inventory-list">
      <li v-for="row in visible" :key="row.realm + ':' + row.uid">
        <div><strong>{{ row.name || '未命名账号' }}</strong><small>{{ row.realm === 'intl' ? '国际版' : '中国版' }} · UID {{ row.uid }}</small></div>
        <div><span>{{ row.enabled === null ? '未注明启用状态' : row.enabled ? '已启用' : '未启用' }}</span>
          <small>{{ row.expiresAt === null ? '未注明到期时间' : '到期：' + fmt.format(row.expiresAt) }}</small></div>
      </li>
    </ul>
    <nav v-if="pages > 1" class="pagination" aria-label="本地清单分页">
      <span>第 {{ page }} / {{ pages }} 页</span><div>
        <button type="button" :disabled="page === 1" aria-label="清单上一页" @click="page--">‹</button>
        <button type="button" :disabled="page === pages" aria-label="清单下一页" @click="page++">›</button>
      </div>
    </nav>
  </section>
</template>
<style scoped>
.inventory { margin: 16px 0; border: 1px solid #dbe8fb; border-radius: 12px; padding: 14px; background: #f7faff; color: #284669; }
.inventory h3 { margin: 0; font-size: 14px; }
.inventory h3 span { font-size: 12px; margin-inline-start: 4px; color: var(--deep); }
.inventory p, .inventory small { font-size: 11px; color: #526783; }
.inventory-list { list-style: none; padding: 0; margin: 0; }
.inventory-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 0; border-top: 1px solid #dae6f6; font-size: 12px; }
.inventory-list li > div { min-width: 0; overflow-wrap: anywhere; }
.inventory-list li > div:last-child { text-align: end; }
.inventory small { display: block; margin-top: 3px; }
</style>
