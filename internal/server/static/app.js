/* UI state and eight-worker scheduler. UI credentials are kept in memory, not browser storage. */
(function (root) {
  "use strict";
  async function runPool(accounts, check, onState, concurrency = 8, signal) {
    let cursor = 0;
    const results = new Array(accounts.length);
    async function worker() {
      while (cursor < accounts.length) {
        const index = cursor++;
        if (signal && signal.aborted) { results[index] = { status: "cancelled" }; await onState(index, "cancelled", results[index]); continue; }
        await onState(index, "testing");
        try { results[index] = { status: "success", value: await check(accounts[index], signal) }; }
        catch (error) { results[index] = { status: error.kind === "cancelled" ? "cancelled" : "failed", error }; }
        await onState(index, results[index].status, results[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, worker));
    return results;
  }
  if (typeof module === "object" && module.exports) { module.exports = { runPool }; return; }
  const $ = id => document.getElementById(id);
  const input = $("credential-input");
  let importing = false, pickerPending = false, pickerTimer;
  const importQueue = [];
  let importQueueScheduled = false;
  let accounts = [], filter = "all", running = false, controller = null, timer = null, startedAt = 0, toastTimer;
  const statusLabels = { pending: "等待检测", testing: "检测中", success: "检测成功", failed: "检测失败", cancelled: "已取消" };
  function toast(message) { clearTimeout(toastTimer); $("toast").textContent = message; $("toast").classList.add("show"); toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3000); }
  function updateInput() {
    $("check-button").disabled = importing || importQueue.length > 0 || (!running && !input.value.trim());
    $("import-error").hidden = true;
  }
  function setControls() {
    const busy = running || importing || importQueue.length > 0;
    input.disabled = busy; $("upload-button").disabled = busy; $("file-input").disabled = busy;
    $("realm-select").disabled = busy; $("clear-button").disabled = busy;
    $("upload-label").textContent = importing ? "正在导入…" : "导入凭证文件";
    $("upload-button").setAttribute("aria-busy", String(importing));
    $("check-button").disabled = importing || importQueue.length > 0 || (!running && !input.value.trim());
    $("check-button").classList.toggle("running", running);
    $("check-label").textContent = running ? "停止检测" : "开始测活";
    $("live-dot").classList.toggle("active", running);
    $("run-state").className = "run-state" + (running ? " running" : accounts.length ? " complete" : "");
    $("run-state").innerHTML = "<span></span>" + (running ? "正在检测" : controller?.signal.aborted && accounts.length ? "已停止" : accounts.length ? "检测完成" : "等待检测");
    document.querySelectorAll(".row-retry").forEach(button => { button.disabled = running || importing; });
  }
  function formatCredits(value) { return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value || 0)); }
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function makeRow(account, index) {
    const row = element("tr"); row.dataset.index = index;
    row.append(element("td", "index-column", String(index + 1).padStart(2, "0")));
    const accountCell = element("td");
    const accountWrap = element("div", "account-cell" + (account.status === "failed" ? " account-error" : ""));
    accountWrap.append(element("span", "avatar", account.status === "success" ? "✓" : account.status === "failed" ? "!" : "W"));
    const meta = element("div", "account-meta");
    const identity = account.result?.identity || account.credential.nickname || account.credential.uid || (account.error ? "凭证不可用" : "账号 " + (index + 1));
    meta.append(element("span", "account-identity", identity)); meta.title = identity;
    const sub = account.status === "failed" ? (account.error?.message || "未知错误") : account.credential.uid ? "UID " + account.credential.uid.slice(0, 14) + (account.credential.uid.length > 14 ? "…" : "") : "WorkBuddy 账号";
    meta.append(element("span", "account-sub", sub)); accountWrap.append(meta); accountCell.append(accountWrap); row.append(accountCell);
    row.append(element("td", "", account.credential.realm === "cn" ? "国内版" : "国际版"));
    row.append(element("td", "credit-cell", account.result ? formatCredits(account.result.used) : "—"));
    row.append(element("td", "credit-cell", account.result ? formatCredits(account.result.size) : "—"));
    const usageCell = element("td");
    if (account.result) {
      const percent = account.result.size > 0 ? Math.min(100, Math.max(0, account.result.used / account.result.size * 100)) : 0;
      const wrap = element("div", "usage-mini"), track = element("div", "usage-track"), fill = element("span");
      fill.style.width = percent + "%"; track.append(fill); wrap.append(track, element("small", "", percent.toFixed(1) + "%")); usageCell.append(wrap);
    } else usageCell.textContent = "—";
    row.append(usageCell);
    const statusCell = element("td");
    statusCell.append(element("span", "status-badge " + account.status, statusLabels[account.status])); row.append(statusCell);
    const action = element("td", "action-column"), retry = element("button", "row-retry");
    retry.type = "button"; retry.title = "重新检测此账号"; retry.setAttribute("aria-label", "重新检测第 " + (index + 1) + " 个账号");
    retry.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6a5 5 0 1 0 0 5m0-5V1m0 5H8"/></svg>';
    retry.disabled = running || importing; retry.addEventListener("click", () => startRun([index])); action.append(retry); row.append(action);
    ["序号", "账号信息", "版本", "已用额度", "总额度", "额度使用", "状态", "操作"].forEach((label, i) => { row.cells[i].dataset.label = label; });
    return row;
  }
  function visible(account) { return filter === "all" || account.status === filter; }
  function syncRows() {
    const body = $("results-body");
    const rows = new Map(Array.from(body.rows, row => [Number(row.dataset.index), row]));
    let count = 0;
    accounts.forEach((account, index) => {
      const matches = visible(account);
      if (matches) count++;
      let row = rows.get(index);
      if (!matches) { if (row) row.remove(); return; }
      // Reuse every existing cell: rebuilding all rows during a retry restarts
      // animations, changes table layout, and resets the button under the pointer.
      if (!row) { row = makeRow(account, index); body.insertBefore(row, body.rows[count - 1] || null); }
      else {
        row.querySelector(".account-identity").textContent = account.result?.identity || account.credential.nickname || account.credential.uid || (account.error ? "凭证不可用" : "账号 " + (index + 1));
        row.querySelector(".account-cell").classList.toggle("account-error", account.status === "failed");
        row.querySelector(".account-meta").title = row.querySelector(".account-identity").textContent;
        row.querySelector(".account-sub").textContent = account.status === "failed" ? (account.error?.message || "未知错误") : account.credential.uid ? "UID " + account.credential.uid.slice(0, 14) + (account.credential.uid.length > 14 ? "…" : "") : "WorkBuddy 账号";
        row.querySelector(".avatar").textContent = account.status === "success" ? "✓" : account.status === "failed" ? "!" : "W";
        const status = row.querySelector(".status-badge");
        status.className = "status-badge " + account.status;
        status.textContent = statusLabels[account.status];
        row.querySelector(".row-retry").disabled = running || importing;
        row.querySelector(".row-retry").classList.toggle("is-spinning", account.status === "testing");
        row.cells[3].textContent = account.result ? formatCredits(account.result.used) : "—";
        row.cells[4].textContent = account.result ? formatCredits(account.result.size) : "—";
        row.cells[5].replaceChildren();
        if (account.result) {
          const percent = account.result.size > 0 ? Math.min(100, Math.max(0, account.result.used / account.result.size * 100)) : 0;
          const wrap = element("div", "usage-mini"), track = element("div", "usage-track"), fill = element("span");
          fill.style.width = percent + "%"; track.append(fill); wrap.append(track, element("small", "", percent.toFixed(1) + "%")); row.cells[5].append(wrap);
        } else row.cells[5].textContent = "—";
      }
    });
    $("empty-state").hidden = count > 0;
    $("empty-title").textContent = accounts.length ? "当前筛选下暂无记录" : "好的结果，值得等待";
    $("empty-description").textContent = accounts.length ? "切换上方筛选条件，查看其他检测结果" : "导入凭证并点击「开始测活」，账号信息将在这里展示";
    $("list-summary").textContent = accounts.length ? "显示 " + count + " / " + accounts.length + " 个账号" : "暂无检测记录";
  }
  function renderRows() {
    $("results-body").replaceChildren();
    syncRows();
  }
  function updateStats() {
    const total = accounts.length;
    const success = accounts.filter(a => a.status === "success").length;
    const failed = accounts.filter(a => a.status === "failed").length;
    $("stat-total").textContent = total; $("stat-success").textContent = success; $("stat-failed").textContent = failed;
    $("filter-all-count").textContent = total; $("filter-success-count").textContent = success; $("filter-failed-count").textContent = failed;
  }
  const nextPaint = () => new Promise(resolve => setTimeout(resolve, 0));
  function importProgress(percent, message) {
    $("import-progress").hidden = false;
    $("import-status").textContent = message;
    $("import-percent").textContent = percent + "%";
    $("import-progress-track").setAttribute("aria-valuenow", String(percent));
    $("import-progress-fill").style.width = percent + "%";
  }
  function readFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("文件读取失败，请重新选择"));
      reader.onabort = () => reject(new Error("文件读取已取消"));
      reader.readAsText(file);
    });
  }
  async function importFiles(files) {
    if (running || importing) return;
    const selected = Array.from(files || []);
    if (!selected.length) return;
    importing = true; pickerPending = false; clearTimeout(pickerTimer); setControls();
    const loaded = [], errors = [];
    let duplicates = 0, existing = [], processed = 0;
    $("import-error").hidden = true;
    importProgress(0, "准备读取 " + selected.length + " 个文件…");
    await nextPaint();
    try {
      if (selected.length > 100) throw new Error("单次最多导入 100 个文件，请分批选择");
      if (selected.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024) throw new Error("单次导入文件总大小不能超过 20 MB");
      if (input.value.trim()) existing = root.WBApi.parseCredentials(input.value, $("realm-select").value);
      const key = account => JSON.stringify([account.realm, account.uid, account.accessToken]);
      const seen = new Set(existing.map(key));
      for (const file of selected) {
        importProgress(Math.round(processed / selected.length * 100), "读取 " + (processed + 1) + " / " + selected.length + "：" + file.name);
        await nextPaint();
        try {
          if (file.size > 2 * 1024 * 1024) throw new Error("文件超过 2 MB");
          const text = await readFile(file, ratio => importProgress(Math.min(99, Math.round((processed + ratio) / selected.length * 100)), "正在读取：" + file.name));
          const parsed = root.WBApi.parseCredentials(text, $("realm-select").value);
          const unique = [], localSeen = new Set(seen);
          let skipped = 0;
          for (const credential of parsed) { const id = key(credential); if (localSeen.has(id)) { skipped++; continue; } localSeen.add(id); unique.push(credential); }
          if (existing.length + loaded.length + unique.length > 2000) throw new Error("总账号数超过 2000，请减少文件或清空后导入");
          for (const credential of unique) { seen.add(key(credential)); loaded.push(credential); }
          duplicates += skipped;
        } catch (error) { errors.push(file.name + "：" + error.message); }
        processed++;
        importProgress(Math.round(processed / selected.length * 100), "已处理 " + processed + " / " + selected.length + " 个文件");
        await nextPaint();
      }
      if (loaded.length) input.value = [...existing, ...loaded].map(credential => JSON.stringify(credential)).join("\n");
      updateInput();
      if (loaded.length) toast(errors.length ? "部分文件已导入，请查看错误提示" : "导入完成");
      else if (!errors.length && duplicates) toast("这些凭证已在输入框中");
    } catch (error) { errors.push(error.message); }
    finally {
      $("import-progress").hidden = true;
      $("import-status").textContent = "";
      if (errors.length) { $("import-error").textContent = errors.join("；"); $("import-error").hidden = false; }
      importing = false; $("file-input").value = ""; setControls();
    }
  }
  function progress() {
    const done = accounts.filter(a => !["pending", "testing"].includes(a.status)).length;
    const total = accounts.length;
    const percent = total ? Math.round(done / total * 100) : 0;
    $("progress-fill").style.width = percent + "%";
    $("progress-percent").textContent = percent + "%";
    $("progress-track").setAttribute("aria-valuenow", String(percent));
    $("progress-detail").textContent = done + " / " + total + " 个账号";
    $("progress-label").textContent = running ? "正在检测账号状态…" : total ? (controller?.signal.aborted ? "检测已停止" : "全部检测完成") : "等待导入凭证";
    const elapsed = startedAt ? ((Date.now() - startedAt) / 1000).toFixed(1) : 0;
    $("elapsed").textContent = startedAt ? "已用时 " + elapsed + " 秒" : "8 线程就绪";
  }
  function renderProgress(index, status, result) {
    const account = accounts[index];
    account.status = status;
    if (status === "success") account.result = result.value;
    if (status === "failed") account.error = result.error;
    updateStats(); progress(); syncRows();
  }
  async function startRun(indices) {
    if (importing) return;
    if (running) { controller.abort(); $("check-label").textContent = "正在停止…"; return; }
    if (!indices) {
      try {
        const parsed = root.WBApi.parseCredentials(input.value, $("realm-select").value);
        accounts = parsed.map(credential => ({ credential, status: "pending", result: null, error: null }));
      } catch (error) { $("import-error").textContent = "导入失败：" + error.message + "。请确认每行是一个独立 JSON 对象。"; $("import-error").hidden = false; return; }
      indices = accounts.map((_, index) => index);
      $("results").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    } else {
      for (const index of indices) { accounts[index].status = "pending"; accounts[index].result = null; accounts[index].error = null; }
    }
    running = true; controller = new AbortController(); startedAt = Date.now();
    if (indices.length === accounts.length) renderRows();
    else syncRows();
    setControls(); updateStats(); progress();
    timer = setInterval(progress, 200);
    try {
      const selected = indices.map(index => ({ account: accounts[index].credential, index }));
      await runPool(selected, (entry, signal) => root.WBApi.checkAccount(entry.account, { signal }), async (position, status, result) => {
        renderProgress(selected[position].index, status, result);
      }, 8, controller.signal);
    } finally {
      clearInterval(timer); timer = null; running = false;
      setControls(); syncRows(); progress();
      const success = accounts.filter(a => a.status === "success").length;
      const failed = accounts.filter(a => a.status === "failed").length;
      toast((controller.signal.aborted ? "检测已停止：成功 " : "检测完成：成功 ") + success + "，失败 " + failed);
    }
  }
  input.addEventListener("input", updateInput);
  function releasePicker() { clearTimeout(pickerTimer); pickerPending = false; }
  function scheduleImportQueue() {
    if (importQueueScheduled || importing || !importQueue.length) return;
    importQueueScheduled = true;
    setTimeout(async () => {
      importQueueScheduled = false;
      if (importing || !importQueue.length) return;
      await importFiles(importQueue.shift());
      scheduleImportQueue();
    }, 0);
  }
  function enqueueFiles(files) {
    // Copy the browser-owned FileList during the change/drop event, before any await.
    const selected = Array.from(files || []).filter(Boolean);
    if (running) { toast("正在检测，请先停止检测后再导入"); return; }
    if (!selected.length) { toast("未读取到文件，请选择文件而不是文件夹，或使用导入按钮"); return; }
    if (selected.length > 100 || importQueue.reduce((n, batch) => n + batch.length, 0) + selected.length > 100) {
      toast("每批及等待队列最多 100 个文件，请分批导入"); return;
    }
    if (selected.reduce((n, file) => n + file.size, 0) > 20 * 1024 * 1024 || importQueue.flat().reduce((n, file) => n + file.size, 0) + selected.reduce((n, file) => n + file.size, 0) > 20 * 1024 * 1024) {
      toast("每批及等待队列总大小不能超过 20 MB"); return;
    }
    importQueue.push(selected);
    setControls();
    if (importing) toast("已加入导入队列：" + selected.length + " 个文件");
    scheduleImportQueue();
  }
  // The transparent native input receives the real user tap/click. No synthetic
  // label+button double activation, and no MIME filter that hides mobile files.
  $("file-input").addEventListener("click", event => {
    event.stopPropagation();
    if (running || importing || pickerPending || event.detail > 1) { event.preventDefault(); return; }
    pickerPending = true;
  });
  $("upload-button").addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation();
    if (!running && !importing && !pickerPending) $("file-input").click();
  });
  $("file-input").addEventListener("change", event => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    releasePicker();
    if (files.length) enqueueFiles(files);
  });
  $("file-input").addEventListener("cancel", releasePicker);
  const pickerReturned = () => { if (pickerPending) { clearTimeout(pickerTimer); pickerTimer = setTimeout(releasePicker, 500); } };
  window.addEventListener("focus", pickerReturned);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pickerReturned(); });
  $("check-button").addEventListener("click", () => startRun());
  $("clear-button").addEventListener("click", () => {
    if (running || importing) return;
    releasePicker(); importQueue.length = 0; $("import-progress").hidden = true;
    input.value = ""; accounts = []; filter = "all"; startedAt = 0; controller = null;
    document.querySelectorAll(".filter-pill").forEach(button => { const active = button.dataset.filter === "all"; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); });
    updateInput(); updateStats(); renderRows(); progress(); setControls(); toast("已清空当前页面中的数据");
  });
  document.querySelectorAll(".filter-pill").forEach(button => button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll(".filter-pill").forEach(item => { const active = item === button; item.classList.toggle("active", active); item.setAttribute("aria-pressed", String(active)); });
    renderRows();
  }));
  const dropZone = $("import-workspace");
  let dragDepth = 0;
  const hasFiles = transfer => transfer && (Array.from(transfer.types || []).includes("Files") || Array.from(transfer.items || []).some(item => item.kind === "file") || transfer.files?.length);
  for (const eventName of ["dragenter", "dragover"]) dropZone.addEventListener(eventName, event => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    if (eventName === "dragenter") dragDepth++;
    event.dataTransfer.dropEffect = running ? "none" : "copy";
    if (!running) dropZone.classList.add("dragging");
  });
  dropZone.addEventListener("dragleave", event => {
    if (!hasFiles(event.dataTransfer)) return;
    if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove("dragging"); }
  });
  dropZone.addEventListener("drop", event => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    dragDepth = 0; dropZone.classList.remove("dragging"); releasePicker();
    const transfer = event.dataTransfer;
    let files = Array.from(transfer.files || []);
    if (!files.length) files = Array.from(transfer.items || []).filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean);
    enqueueFiles(files);
  });
  for (const eventName of ["dragover", "drop"]) document.addEventListener(eventName, event => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (eventName === "drop") { dragDepth = 0; dropZone.classList.remove("dragging"); toast("请把文件拖到导入账号凭证区域"); }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && timer) { clearInterval(timer); timer = null; } else if (!document.hidden && running && !timer) timer = setInterval(progress, 200); });
  updateInput(); updateStats(); setControls();
})(typeof window !== "undefined" ? window : globalThis);
