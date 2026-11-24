import { computed, reactive, shallowRef, triggerRef } from 'vue'
import { CheckError, checkAccount, parseImportAsync } from './api.js'

const accounts = shallowRef([])
const inventoryRows = shallowRef([])
const index = shallowRef({ all: [], success: [], failed: [], pending: [], testing: [], cancelled: [] })
const positions = Object.fromEntries(Object.keys(index.value).map(key => [key, new Map()]))
const counters = reactive({ success: 0, failed: 0, pending: 0, testing: 0, cancelled: 0 })
const activeFilter = shallowRef('all')
const currentPage = shallowRef(1)
const pageSize = 80
const inputText = shallowRef('')
const realm = shallowRef('cn')
const running = shallowRef(false)
const importing = shallowRef(false)
const importProgress = reactive({ visible: false, percent: 0, label: '', mode: 'idle' })
const toastText = shallowRef('')
const notice = shallowRef('')
const fileInput = shallowRef(null)
let importFinishTimer
let toastTimer
let importQueue = []
let importingQueue = false
let runController = null

const filters = [
  { key: 'all', label: '全部账号', icon: 'grid' },
  { key: 'success', label: '已验证', icon: 'check' },
  { key: 'failed', label: '需检查', icon: 'alert' },
  { key: 'pending', label: '待检测', icon: 'clock' },
]
const accountCount = computed(() => accounts.value.length)
const completedCount = computed(() => counters.success + counters.failed + counters.cancelled)
const runPercent = computed(() => accountCount.value ? Math.round(completedCount.value / accountCount.value * 100) : 0)
const filterCount = key => key === 'all' ? accountCount.value : counters[key]
const totalPages = computed(() => Math.max(1, Math.ceil((index.value[activeFilter.value] ?? index.value.all).length / pageSize)))
const visibleAccounts = computed(() => (index.value[activeFilter.value] ?? index.value.all)
  .slice((currentPage.value - 1) * pageSize, currentPage.value * pageSize)
  .sort((a, b) => a - b)
  .map(i => accounts.value[i]).filter(Boolean))

function toast(message) {
  toastText.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastText.value = '' }, 3200)
}
function keyOf(credential) { return JSON.stringify([credential.realm, credential.uid ? "uid" : "token", credential.uid || credential.accessToken]) }
function addIndex(list, indexId, positionMap) {
  positionMap.set(indexId, list.length)
  list.push(indexId)
}
function removeIndex(list, indexId, positionMap) {
  const at = positionMap.get(indexId)
  if (at === undefined) return
  const last = list.pop()
  positionMap.delete(indexId)
  if (at < list.length) {
    list[at] = last
    positionMap.set(last, at)
  }
}
function changeStatus(record, status, detail = null) {
  if (record.status !== status) {
    if (record.status) {
      counters[record.status]--
      removeIndex(index.value[record.status], record.index, positions[record.status])
    }
    counters[status]++
    addIndex(index.value[status], record.index, positions[status])
    record.status = status
    index.value = { ...index.value }
  }
  if (status === 'success') {
    record.result = detail
    record.error = null
  } else if (status === 'failed') {
    record.error = detail
    record.result = null
  }
}
function addCredentials(credentials) {
  const known = new Map(accounts.value.map(row => [keyOf(row.credential), row]))
  const added = []
  let duplicates = 0, updated = 0
  for (const credential of credentials) {
    const key = keyOf(credential)
    const existing = known.get(key)
    if (existing) {
      const sameToken = existing.credential.accessToken === credential.accessToken
      if (sameToken && !credential.refreshToken) credential.refreshToken = existing.credential.refreshToken
      if (JSON.stringify(existing.credential) === JSON.stringify(credential)) { duplicates++; continue }
      existing.credential = credential
      existing.result = null
      existing.error = null
      changeStatus(existing, 'pending')
      updated++
      continue
    }
    const record = { index: accounts.value.length + added.length, credential, status: 'pending', result: null, error: null }
    known.set(key, record)
    added.push(record)
    addIndex(index.value.all, record.index, positions.all)
    counters.pending++
    addIndex(index.value.pending, record.index, positions.pending)
  }
  for (const record of added) accounts.value.push(record)
  triggerRef(accounts)
  index.value = { ...index.value }
  if (activeFilter.value !== 'all' && activeFilter.value !== 'pending') activeFilter.value = 'all'
  currentPage.value = 1
  return { added: added.length, duplicates, updated }
}
function setFilter(key) { activeFilter.value = key; currentPage.value = 1 }
function clearAll() {
  if (running.value || importing.value || importQueue.length) return
  accounts.value = []
  inventoryRows.value = []
  index.value = { all: [], success: [], failed: [], pending: [], testing: [], cancelled: [] }
  for (const values of Object.values(positions)) values.clear()
  for (const key of Object.keys(counters)) counters[key] = 0
  activeFilter.value = 'all'
  currentPage.value = 1
  inputText.value = ''
  notice.value = ''
  importProgress.visible = false
  toast('已清除本页数据')
}
function updateImport(percent, label, mode) {
  importProgress.visible = true
  importProgress.percent = Math.min(100, Math.max(0, Math.round(percent)))
  importProgress.label = label
  importProgress.mode = mode
}
function finishImport() {
  importProgress.visible = false
}
function readFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total) }
    reader.onerror = () => reject(new Error('文件读取失败，请重新选择'))
    reader.onabort = () => reject(new Error('文件读取已取消'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsText(file)
  })
}
async function ingestText(text, label) {
  if (!text.trim()) throw new CheckError('请选择凭证文件，或先粘贴 JSON / JSONL 凭证', 'input')
  const imported = await parseImportAsync(text, realm.value, fraction => {
    updateImport(35 + fraction * 55, `${label} · 正在解析凭证`, 'parse')
  })
  const offline = imported.kind === 'inventory' ? imported.rows : imported.inventoryRows || []
  const result = addCredentials(imported.kind === 'inventory' ? [] : imported.rows)
  const key = row => JSON.stringify([row.realm, row.uid])
  const onlineKeys = new Set(accounts.value.map(row => key(row.credential)))
  const merged = new Map(inventoryRows.value.map(row => [key(row), row]))
  for (const row of offline) merged.set(key(row), row)
  inventoryRows.value = Array.from(merged.values()).filter(row => !onlineKeys.has(key(row)))
  if (imported.kind === 'inventory') toast('已导入 ' + offline.length.toLocaleString() + ' 条无令牌清单记录；测活需要 accessToken')
  else toast('凭证：新增 ' + result.added.toLocaleString() + ' · 更新 ' + result.updated.toLocaleString() + ' · 重复 ' + result.duplicates.toLocaleString())
  return result
}
async function processFiles(files) {
  if (importingQueue) {
    importQueue.push(...files)
    updateImport(0, `已排队 ${importQueue.length.toLocaleString()} 个文件`, 'queued')
    return
  }
  clearTimeout(importFinishTimer)
  importingQueue = true
  notice.value = ''
  importQueue.push(...files)
  importing.value = true
  let processed = 0
  const errors = []
  try {
    while (importQueue.length) {
      const file = importQueue.shift()
      const position = processed + 1
      const total = processed + 1 + importQueue.length
      try {
        updateImport(0, `读取 ${position.toLocaleString()} / ${total.toLocaleString()} · ${file.name}`, 'read')
        const content = await readFile(file, fraction => updateImport(
          ((position - 1 + fraction * 0.72) / total) * 100,
          `读取 ${position.toLocaleString()} / ${total.toLocaleString()} · ${file.name}`,
          'read',
        ))
        updateImport(((position - 1 + 0.75) / total) * 100, `解析 ${position.toLocaleString()} / ${total.toLocaleString()} · ${file.name}`, 'parse')
        await ingestText(content, file.name)
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`)
      }
      processed++
      updateImport(Math.round(processed / total * 100), `已处理 ${processed.toLocaleString()} 个文件`, 'complete')
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
  } finally {
    importing.value = false
    importingQueue = false
    importQueue = []
    if (errors.length) {
      notice.value = errors.slice(0, 4).join('；') + (errors.length > 4 ? `；另有 ${errors.length - 4} 个文件读取失败` : '')
      toast(`${errors.length.toLocaleString()} 个文件未能导入，请查看提示`)
    }
    importFinishTimer = setTimeout(finishImport, errors.length ? 5000 : 1100)
  }
}
async function importPasted() {
  if (running.value || importing.value || !inputText.value.trim()) return
  clearTimeout(importFinishTimer)
  importing.value = true
  notice.value = ''
  try {
    await new Promise(resolve => requestAnimationFrame(resolve))
    await ingestText(inputText.value, '粘贴内容')
    inputText.value = ''
  } catch (error) {
    notice.value = error.message
    toast('导入失败，请检查凭证格式')
  } finally {
    importing.value = false
    updateImport(100, '粘贴内容处理完成', 'complete')
    importFinishTimer = setTimeout(finishImport, 900)
  }
}
function onFiles(event) {
  const files = Array.from(event.target?.files ?? event.dataTransfer?.files ?? [])
  if (event.target) event.target.value = ''
  if (files.length) void processFiles(files)
}
function onDrop(event) {
  if (running.value) return
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length) { event.preventDefault(); void processFiles(files) }
}
async function runPool(rows, controller) {
  let cursor = 0
  async function worker() {
    while (cursor < rows.length) {
      const record = rows[cursor++]
      if (controller.signal.aborted) { changeStatus(record, 'cancelled'); continue }
      changeStatus(record, 'testing')
      try {
        const result = await checkAccount(record.credential, { signal: controller.signal })
        changeStatus(record, 'success', result)
      } catch (error) {
        changeStatus(record, error.kind === 'cancelled' || controller.signal.aborted ? 'cancelled' : 'failed', error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, rows.length) }, worker))
}
async function startCheck(rows = null) {
  if (importing.value || running.value) return
  if (!accounts.value.length) {
    if (inputText.value.trim()) { await importPasted(); return }
    toast('请先导入账号凭证')
    return
  }
  const targets = rows ?? accounts.value
  if (!targets.length) { toast('没有需要重新检测的账号'); return }
  for (const row of targets) changeStatus(row, 'pending')
  running.value = true
  notice.value = ''
  runController = new AbortController()
  const count = targets.length
  toast(targets === accounts.value ? `正在检测全部 ${count.toLocaleString()} 个账号` : `正在重新检测 ${count.toLocaleString()} 个账号`)
  try {
    await runPool(targets, runController)
  } finally {
    running.value = false
    runController = null
    toast(countsMessage())
  }
}
function retryFailed() { return startCheck(accounts.value.filter(record => record.status === 'failed')) }
function stopCheck() { runController?.abort() }
function countsMessage() { return `${counters.success.toLocaleString()} 已验证 · ${counters.failed.toLocaleString()} 需检查` }
function previousPage() { currentPage.value = Math.max(1, currentPage.value - 1) }
function nextPage() { currentPage.value = Math.min(totalPages.value, currentPage.value + 1) }
function retry(record) { if (!running.value && !importing.value) void startCheck([record]) }
function errorMessage(record) { return record.error?.message || '官方接口暂时无法验证，请稍后重试' }
function meterPercent(record) {
  const size = Number(record.result?.size || 0)
  return size > 0 ? Math.min(100, Math.max(0, Number(record.result.used || 0) / size * 100)) : 0
}
function number(value) { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value || 0)) }
function identity(record) {
  return record.result?.identity || record.credential.nickname || record.credential.uid || (record.error ? '凭证需要检查' : `账号 ${record.index + 1}`)
}
function maskedUid(record) {
  const uid = record.credential.uid
  return uid ? `UID ${uid.slice(0, 16)}${uid.length > 16 ? '…' : ''}` : (record.credential.realm === 'intl' ? 'GLOBAL' : 'WORKBUDDY')
}
function statusLabel(status) {
  return ({ pending: '待检测', testing: '验证中', success: '正常', failed: '需检查', cancelled: '已停止' })[status] || status
}
export { activeFilter, accountCount, inventoryRows, clearAll, completedCount, counters, currentPage, errorMessage, fileInput, filterCount, filters, identity, importPasted, importProgress, importing, maskedUid, meterPercent, nextPage, notice, number, onDrop, onFiles, pageSize, previousPage, realm, retry, retryFailed, runPercent, running, setFilter, startCheck, stopCheck, totalPages, toastText, visibleAccounts, inputText, statusLabel }
