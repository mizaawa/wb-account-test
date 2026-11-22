/* UI state and eight-worker scheduler. Credentials exist only in this tab's memory. */
(function (root) {
  "use strict";
  async function runPool(accounts, check, onState, concurrency = 8, signal) {
    let cursor = 0;
    const results = new Array(accounts.length);
    async function worker() {
      while (cursor < accounts.length) {
        const index = cursor++;
        if (signal && signal.aborted) { results[index] = { status: "cancelled" }; continue; }
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
  let accounts = [], importedFiles = [], filter = "all", running = false, controller = null, timer = null, startedAt = 0, toastTimer;
  const statusLabels = { pending: "等待检测", testing: "检测中", success: "检测成功", failed: "检测失败", cancelled: "已取消" };
  function toast(message) { clearTimeout(toastTimer); $("toast").textContent = message; $("toast").classList.add("show"); toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3000); }
  function updateInput() {
    const lines = input.value.trim() ? input.value.trim().split(/\r?\n/).length : 0;
    $("line-count").textContent = lines + " 行内容";
    $("check-button").disabled = running || !input.value.trim();
    $("import-error").hidden = true;
  }
  function setControls() {
    input.disabled = running; $("upload-button").disabled = running; $("file-input").disabled = running;
    $("realm-select").disabled = running; $("clear-button").disabled = running;
    $("check-button").disabled = running ? false : !input.value.trim();
    $("check-button").classList.toggle("running", running);
    $("check-label").textContent = running ? "停止检测" : "开始测活";
    $("live-dot").classList.toggle("active", running);
    $("run-state").className = "run-state" + (running ? " running" : accounts.length ? " complete" : "");
    $("run-state").innerHTML = "<span></span>" + (running ? "正在检测" : accounts.length ? "检测完成" : "等待检测");
    document.querySelectorAll(".row-retry").forEach(button => { button.disabled = running; });
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
    retry.disabled = running; retry.addEventListener("click", () => startRun([index])); action.append(retry); row.append(action);
    return row;
  }
  function visible(account) { return filter === "all" || account.status === filter; }
  function syncRows() {
    const body = $("results-body");
    const rows = body.rows;
    let count = 0;
    accounts.forEach((account, index) => {
      const matches = visible(account);
      if (matches) count++;
      const row = rows[index];
      if (!matches) { if (row) row.remove(); return; }
      // Reuse every existing cell: rebuilding all rows during a retry restarts
      // animations, changes table layout, and resets the button under the pointer.
      if (!row) body.append(makeRow(account, index));
      else {
        row.querySelector(".account-identity").textContent = account.result?.identity || account.credential.nickname || account.credential.uid || (account.error ? "凭证不可用" : "账号 " + (index + 1));
        row.querySelector(".account-sub").textContent = account.status === "failed" ? (account.error?.message || "未知错误") : account.credential.uid ? "UID " + account.credential.uid.slice(0, 14) + (account.credential.uid.length > 14 ? "…" : "") : "WorkBuddy 账号";
        row.querySelector(".avatar").textContent = account.status === "success" ? "✓" : account.status === "failed" ? "!" : "W";
        const status = row.querySelector(".status-badge");
        status.className = "status-badge " + account.status;
        status.textContent = statusLabels[account.status];
        row.querySelector(".row-retry").disabled = running;
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
  async function importFiles(files) {
    if (running) return;
    const selected = Array.from(files || []);
    if (!selected.length) return;
    const loaded = [], errors = [];
    for (const file of selected.slice(0, 100)) {
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error("文件超过 2 MB");
        const parsed = root.WBApi.parseCredentials(await file.text(), $("realm-select").value);
        loaded.push(...parsed.map(credential => JSON.stringify(credential)));
        importedFiles.push(file.name);
      } catch (error) { errors.push(file.name + "：" + error.message); }
    }
    if (loaded.length) input.value = [input.value.trim(), ...loaded].filter(Boolean).join("\n");
    const chips = $("file-chips"); chips.replaceChildren();
    [...new Set(importedFiles)].forEach(name => chips.append(element("span", "file-chip", name)));
    chips.hidden = !importedFiles.length; updateInput();
    if (errors.length) { $("import-error").textContent = errors.join("；"); $("import-error").hidden = false; }
    toast("已导入 " + loaded.length + " 个凭证" + (errors.length ? "，部分文件未导入" : ""));
    $("file-input").value = "";
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
      toast("检测完成：成功 " + success + "，失败 " + failed);
    }
  }
  input.addEventListener("input", updateInput);
  $("upload-button").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", event => importFiles(event.target.files));
  $("check-button").addEventListener("click", () => startRun());
  $("clear-button").addEventListener("click", () => {
    if (running) return;
    input.value = ""; accounts = []; importedFiles = []; filter = "all"; startedAt = 0;
    $("file-chips").hidden = true; $("file-chips").replaceChildren();
    document.querySelectorAll(".filter-pill").forEach(button => { const active = button.dataset.filter === "all"; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); });
    updateInput(); updateStats(); renderRows(); progress(); setControls(); toast("已清空当前页面中的数据");
  });
  document.querySelectorAll(".filter-pill").forEach(button => button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll(".filter-pill").forEach(item => { const active = item === button; item.classList.toggle("active", active); item.setAttribute("aria-pressed", String(active)); });
    renderRows();
  }));
  const dropZone = $("drop-zone");
  for (const eventName of ["dragenter", "dragover"]) dropZone.addEventListener(eventName, event => { event.preventDefault(); if (!running) dropZone.classList.add("dragging"); });
  for (const eventName of ["dragleave", "drop"]) dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.remove("dragging"); });
  dropZone.addEventListener("drop", event => importFiles(event.dataTransfer.files));
  for (const eventName of ["dragover", "drop"]) document.addEventListener(eventName, event => { event.preventDefault(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && timer) { clearInterval(timer); timer = null; } else if (!document.hidden && running && !timer) timer = setInterval(progress, 200); });
  updateInput(); updateStats(); setControls();
})(typeof window !== "undefined" ? window : globalThis);
