<script setup>
import { computed } from 'vue'
import RealmSelect from './RealmSelect.vue'
import InventoryPanel from './InventoryPanel.vue'
import {
  accountCount, inventoryRows, activeFilter, clearAll, counters, currentPage, errorMessage, fileInput,
  filterCount, filters, identity, importPasted, importProgress, importing, inputText,
  maskedUid, meterPercent, nextPage, notice, number, onDrop, onFiles, pageSize,
  previousPage, realm, retry, retryFailed, runPercent, running, setFilter, startCheck,
  stopCheck, totalPages, toastText, visibleAccounts, statusLabel,
} from './workspace.js'
const runCaption = computed(() => running.value ? '停止测活' : '凭证测活')
function handleRun() { if (running.value) stopCheck(); else void startCheck() }
</script>
<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="./" aria-label="WB Pulse 首页"><span class="brand-mark"><svg viewBox="0 0 32 32" fill="none"><path d="M4 17.5h5.2l3-9 5.7 17L21 14l2.3 4H28" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="16" r="14" stroke="currentColor" opacity=".4"/></svg></span><span class="brand-name">WB <strong>Pulse</strong></span><span class="brand-version">2.0</span></a>
      <div class="topbar-right"><span class="live-tag"><i class="live-dot"></i> 本地解析 · 安全转发</span><a class="github-link" href="https://github.com/mizaawa/wb-account-test" target="_blank" rel="noreferrer">GitHub <span>↗</span></a></div>
    </header>
    <main>
      <section class="hero-card">
        <div class="hero-content"><span class="eyebrow"><span class="spark">✦</span> WORKBUDDY WORKSPACE</span><h1>让每一份用量<br class="mobile-break"> <span>一目了然。</span></h1><p class="hero-copy">导入账号凭证，快速掌握 WorkBuddy 账号状态与使用额度。批量导入无预设账号数量上限。</p><div class="hero-points"><span><i>✓</i> 本地读取，不保存凭证</span><span><i>✓</i> 安全同源请求，不受 CORS 阻拦</span></div></div>
        <div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="pulse-sphere"><svg viewBox="0 0 100 100" fill="none"><path d="M12 52h16l9-25 17 48 13-37 8 14h14" stroke="white" stroke-width="6" stroke-linecap="round"/><circle cx="50" cy="50" r="44" stroke="white" stroke-opacity=".32" stroke-width="1.7"/></svg></div><span class="float-card float-card-top">✦ &nbsp; READY</span><span class="float-card float-card-bottom"><span class="float-green"></span>实时同步状态</span></div><div class="hero-glow"></div>
      </section>
      <section class="stats-grid" aria-label="账号总览">
        <article class="stat-card"><div class="stat-symbol symbol-blue">◈</div><span class="stat-label">{{ inventoryRows.length ? '已导入记录' : '账号总数' }}</span><strong>{{ (accountCount + inventoryRows.length).toLocaleString() }}</strong><span class="stat-foot">{{ inventoryRows.length ? `在线凭证 ${accountCount} · 本地清单 ${inventoryRows.length}` : '已导入至当前页面' }}</span></article>
        <article class="stat-card"><div class="stat-symbol symbol-green">✓</div><span class="stat-label">状态正常</span><strong>{{ counters.success.toLocaleString() }}</strong><span class="stat-foot">已完成身份验证</span></article>
        <article class="stat-card"><div class="stat-symbol symbol-amber">!</div><span class="stat-label">待检查</span><strong>{{ counters.failed.toLocaleString() }}</strong><span class="stat-foot">{{ counters.pending.toLocaleString() }} 个等待中</span></article>
        <article class="stat-card stat-progress-card"><div class="stat-progress-head"><span class="stat-label">检测进度</span><span class="progress-number">{{ runPercent }}<small>%</small></span></div><div class="meter-track"><span :style="{ width: runPercent + '%' }"></span></div><span class="stat-foot">{{ (counters.success + counters.failed + counters.cancelled).toLocaleString() }} / {{ accountCount.toLocaleString() }} 个账号已处理</span></article>
      </section>
      <section class="workspace-grid">
        <article class="panel import-panel" @dragover.prevent @drop="onDrop">
          <div class="panel-title-row"><div><span class="section-kicker">01 / 导入账号</span><h2>添加你的凭证</h2></div><span class="free-badge"><i>∞</i> 无数量上限</span></div>
          <RealmSelect v-model="realm" :disabled="importing || running" />
          <label class="field-label paste-label" for="credential-input">粘贴 JSON / JSONL 凭证</label><textarea id="credential-input" v-model="inputText" :disabled="importing || running" spellcheck="false" autocomplete="off" placeholder='{"uid":"…","accessToken":"…","refreshToken":"…","realm":"cn"}&#10;支持 JSON、JSONL，每行一个账号；新凭证会合并到列表中。'></textarea>
          <button class="paste-button" type="button" :disabled="!inputText.trim() || importing || running" @click="importPasted"><span>＋</span> 解析并导入</button>
          <div class="divider"><span>或者上传凭证文件</span></div>
          <label class="dropzone" for="file-input" @dragover.prevent @drop.prevent.stop="onDrop"><input id="file-input" ref="fileInput" type="file" multiple aria-label="选择一个或多个账号凭证文件" :disabled="running" @change="onFiles"><span class="upload-icon">↑</span><span class="drop-main">拖拽文件到这里，或 <strong>点击选择</strong></span><span class="drop-sub">支持 JSON / JSONL / TXT 和 WBProxyCenter 清单 · 可多选</span></label>
          <div v-if="importProgress.visible" class="import-progress" role="status" aria-live="polite"><div class="import-progress-copy"><span><i v-if="importProgress.mode !== 'complete'" class="spinner"></i>{{ importProgress.label }}</span><strong>{{ importProgress.percent }}%</strong></div><div class="meter-track"><span :style="{ width: importProgress.percent + '%' }"></span></div></div>
          <div v-if="notice" class="notice" role="alert"><span>⚠</span>{{ notice }}</div>
          <div class="privacy-note"><span class="privacy-icon">◇</span><span><strong>隐私说明</strong> 文件只在浏览器解析；点击检测后，凭证通过你部署的 Go 服务临时转发至 WorkBuddy 官方接口。应用不保存凭证。</span></div>
        </article>
        <article class="panel results-panel">
          <div class="panel-title-row results-heading"><div><span class="section-kicker">02 / 账号概览</span><h2>用量与状态</h2></div><div class="action-group"><button v-if="accountCount || inventoryRows.length" class="text-action" type="button" :disabled="running || importing" @click="clearAll">清空</button><button class="run-button" type="button" :disabled="importing || (!running && !accountCount)" :class="{ 'is-running': running }" :title="!accountCount ? '请先导入含 accessToken 的凭证' : '测活全部账号并查询额度'" @click="handleRun"><span>{{ running ? '■' : '↗' }}</span>{{ runCaption }}</button></div></div>
          <InventoryPanel v-if="inventoryRows.length" :rows="inventoryRows" :page-size="pageSize" />
          <div v-show="accountCount || !inventoryRows.length" class="filter-row" role="tablist" aria-label="筛选账号状态"><button v-for="filter in filters" :key="filter.key" type="button" role="tab" :aria-selected="activeFilter === filter.key" :class="{ selected: activeFilter === filter.key }" @click="setFilter(filter.key)">{{ filter.label }}<span>{{ filterCount(filter.key).toLocaleString() }}</span></button></div>
          <div v-show="accountCount || !inventoryRows.length" class="account-count-line"><span><i class="live-dot" :class="{ 'is-busy': running }"></i>{{ running ? '正在安全请求 WorkBuddy 官方接口…' : accountCount ? '账号信息仅保存在当前页面内存' : '你的账号数据会显示在这里' }}</span><span v-if="accountCount">{{ (currentPage - 1) * pageSize + 1 }}–{{ Math.min(currentPage * pageSize, filterCount(activeFilter)).toLocaleString() }} / {{ filterCount(activeFilter).toLocaleString() }}</span></div>
          <div v-if="visibleAccounts.length" class="table-wrap"><table class="accounts-table"><thead><tr><th>账号</th><th>状态</th><th>剩余额度</th><th>使用情况</th><th><span class="sr-only">操作</span></th></tr></thead><tbody><tr v-for="record in visibleAccounts" :key="record.index"><td><div class="identity-cell"><span class="avatar" :class="'avatar-' + record.status">{{ record.status === 'success' ? '✓' : record.status === 'failed' ? '!' : record.credential.realm === 'intl' ? 'G' : 'W' }}</span><span class="identity-copy"><strong>{{ identity(record) }}</strong><small>{{ maskedUid(record) }} · {{ record.credential.realm === 'intl' ? '国际版' : '中国版' }}</small></span></div></td><td><span class="status-pill" :class="'status-' + record.status"><i></i>{{ statusLabel(record.status) }}</span></td><td><div v-if="record.result" class="quota-cell"><strong>{{ number(record.result.remain) }}</strong><small>/ {{ number(record.result.size) }} 单位</small></div><span v-else class="muted-value">{{ record.status === 'failed' ? '暂不可用' : '—' }}</span></td><td><div v-if="record.result" class="row-usage"><div class="usage-track"><i :class="{ 'usage-high': meterPercent(record) >= 85 }" :style="{ width: meterPercent(record) + '%' }"></i></div><small>{{ meterPercent(record).toFixed(0) }}% 已使用</small></div><span v-else class="muted-value error-cell">{{ record.status === 'failed' ? errorMessage(record) : '等待验证' }}</span></td><td><button v-if="record.status === 'failed'" class="retry-button" type="button" :disabled="running || importing" aria-label="重试此账号" @click="retry(record)">重试 ↗</button></td></tr></tbody></table></div>
          <div v-else-if="!accountCount && !inventoryRows.length" class="empty-state"><div class="empty-illustration">◈<span>✦</span></div><h3>一份清晰的用量快照</h3><p>在左侧导入凭证，开始查看账号状态与额度。</p></div><div v-else-if="accountCount" class="empty-filter"><span>✦</span><strong>这里暂时没有账号</strong><p>试试切换状态筛选。</p></div>
          <div v-if="filterCount(activeFilter) > pageSize" class="pagination"><span>第 {{ currentPage }} / {{ totalPages }} 页 · 每页 {{ pageSize }} 个账号</span><div><button type="button" :disabled="currentPage <= 1" aria-label="上一页" @click="previousPage">‹</button><button type="button" :disabled="currentPage >= totalPages" aria-label="下一页" @click="nextPage">›</button></div></div>
          <div class="list-footer"><span><i :class="{ 'is-busy': running }"></i>{{ running ? '测活中 · 最大 8 并发' : '同源安全链路 · 就绪' }}</span><button type="button" :disabled="!counters.failed || running" @click="retryFailed">批量重试失败项 <span>↗</span></button></div>
        </article>
      </section>
    </main>
    <footer><span>WB Pulse <span class="footer-dot">·</span> WorkBuddy 用量看板</span><span>请仅导入你本人有权使用的账号凭证</span></footer>
    <Transition name="toast"><div v-if="toastText" class="toast-message" role="status"><span>✦</span> {{ toastText }}</div></Transition>
  </div>
</template>
