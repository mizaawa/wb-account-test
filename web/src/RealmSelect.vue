<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const model = defineModel({ type: String, required: true })
const props = defineProps({ disabled: Boolean })
const options = [
  { value: 'cn', label: '中国版 · WorkBuddy' },
  { value: 'intl', label: '国际版 · WorkBuddy' },
]
const selected = computed(() => options.find(option => option.value === model.value) ?? options[0])
const field = ref(null)
const trigger = ref(null)
const expanded = ref(false)
const active = ref(0)

function open() {
  if (props.disabled) return
  active.value = options.indexOf(selected.value)
  expanded.value = true
}
function close() { expanded.value = false }
function choose(index) {
  if (!expanded.value || props.disabled) return
  model.value = options[index].value
  close()
}
function toggle() {
  trigger.value.focus({ preventScroll: true })
  if (expanded.value) close()
  else open()
}
function onKey(event) {
  if (props.disabled) return
  const last = options.length - 1
  switch (event.key) {
    case 'ArrowDown': case 'ArrowUp':
      if (!expanded.value) open()
      else active.value = Math.max(0, Math.min(last, active.value + (event.key === 'ArrowDown' ? 1 : -1)))
      break
    case 'Home': case 'End':
      open()
      active.value = event.key === 'Home' ? 0 : last
      break
    case 'Enter': case ' ':
      if (!event.repeat) { if (expanded.value) choose(active.value); else open() }
      break
    case 'Escape':
      if (!expanded.value) return
      close()
      break
    case 'Tab':
      if (expanded.value) choose(active.value)
      return // Let the browser move focus normally.
    default: return
  }
  event.preventDefault()
}
function onOutside(event) { if (expanded.value && !field.value?.contains(event.target)) close() }
onMounted(() => document.addEventListener('pointerdown', onOutside, true))
onUnmounted(() => document.removeEventListener('pointerdown', onOutside, true))
watch(() => props.disabled, disabled => { if (disabled) close() })
</script>

<template>
  <div ref="field" class="realm-row">
    <label id="realm-label" class="field-label" for="realm-select">默认账号版本</label>
    <div class="realm-picker">
      <button id="realm-select" ref="trigger" type="button" role="combobox" class="realm-trigger"
        aria-labelledby="realm-label" aria-haspopup="listbox" aria-controls="realm-list" :aria-expanded="expanded"
        :aria-activedescendant="expanded ? 'realm-' + options[active].value : undefined" :disabled="disabled"
        @click="toggle" @keydown="onKey" @blur="close">
        <span class="realm-dot" aria-hidden="true"></span>
        <span class="realm-value">{{ selected.label }}</span>
        <span class="realm-icon" aria-hidden="true">
          <svg class="realm-chevron" viewBox="0 0 20 20" fill="none" focusable="false">
            <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </button>
      <ul v-show="expanded" id="realm-list" role="listbox" aria-labelledby="realm-label" class="realm-menu" @mousedown.prevent>
        <li v-for="(option, index) in options" :id="'realm-' + option.value" :key="option.value" role="option"
          :aria-selected="model === option.value" :class="{ 'is-active': index === active }"
          @pointermove="active = index" @click="choose(index)">
          {{ option.label }}
          <svg v-if="model === option.value" class="realm-check" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
            <path d="m3 8 3.2 3.2L13 4.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.realm-row { flex-wrap: wrap; gap: 8px; }
.realm-picker { position: relative; margin-inline-start: auto; max-inline-size: 100%; }
.realm-trigger {
  appearance: none; display: grid; grid-template-columns: 7px auto 24px;
  align-items: center; gap: 8px; min-height: 42px;
  padding: 6px 9px 6px 12px; border: 1px solid #ccdff9; border-radius: 12px;
  background: #f4f8ff; color: #23436b; font-size: 12px; font-weight: 650; line-height: 18px;
  transition: background .15s, border-color .15s, box-shadow .15s;
}
.realm-trigger:hover:not(:disabled), .realm-trigger[aria-expanded="true"] {
  background: #eef5ff; border-color: #8bb9fb; box-shadow: 0 0 0 3px #1671f912;
}
.realm-trigger:disabled { color: #607897; background: #f3f6fa; border-color: #dce5f1; cursor: not-allowed; }
.realm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 3px #e0ecff; }
.realm-value { white-space: nowrap; }
.realm-icon { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: #e2eeff; color: var(--deep); }
.realm-chevron { display: block; width: 16px; height: 16px; transition: transform .16s ease-out; }
.realm-trigger[aria-expanded="true"] .realm-chevron { transform: rotate(180deg); }
.realm-trigger:disabled .realm-icon { color: inherit; background: #e9eef5; }
.realm-trigger:disabled .realm-dot { background: #91a4bb; box-shadow: none; }
.realm-menu {
  position: absolute; z-index: 5; inset-inline: 0; top: calc(100% + 5px);
  margin: 0; padding: 4px; list-style: none; border: 1px solid #ccdef6; border-radius: 12px;
  background: #fff; box-shadow: 0 10px 24px #1b467225, 0 2px 6px #1b46720d;
  animation: realm-appear .14s ease-out;
}
.realm-menu li {
  display: flex; align-items: center; justify-content: space-between; gap: 5px;
  min-height: 40px; padding: 5px 8px; border-radius: 8px; color: #354e70;
  font-size: 12px; line-height: 18px; white-space: nowrap; cursor: pointer;
}
.realm-menu li + li { margin-top: 2px; }
.realm-menu [aria-selected="true"] { color: var(--deep); background: #e9f2ff; font-weight: 700; }
.realm-menu .is-active { background: #eef5ff; outline: 1px solid #9ac3ff; outline-offset: -1px; }
.realm-menu .is-active[aria-selected="true"] { background: #e0edff; }
.realm-check { display: block; width: 15px; height: 15px; flex: none; }
@keyframes realm-appear { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
</style>
