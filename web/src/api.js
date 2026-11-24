
  const VERSION = "2.0.4";
  const relayBase = typeof document !== "undefined" ? document.baseURI : null;
  let relayReady = null;
  function localURL(relative) {
    if (!relayBase) return relative;
    const target = new URL(relative, relayBase);
    if (target.origin !== location.origin || !/^https?:$/.test(target.protocol)) throw new CheckError("检测服务必须与页面同源，请使用完整 Docker 服务而不是静态页面", "deployment");
    return target.href;
  }
  async function ensureRelay(signal) {
    if (!relayBase) return;
    if (!relayReady) relayReady = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(localURL("api/status"), { mode: "same-origin", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
        const status = response.ok ? await response.json() : null;
        if (!status || status.service !== "wb-pulse" || status.relay !== "same-origin" || status.version !== VERSION) throw new CheckError("页面与检测服务版本不一致或 API 反代缺失，请更新容器、刷新页面并检查 api/ 转发（需要 v" + VERSION + "）", "deployment");
      } catch (error) {
        if (error instanceof CheckError) throw error;
        throw new CheckError("无法验证本站检测服务，请检查容器、反向代理与网络后重试", "deployment");
      } finally { clearTimeout(timeout); }
    })().catch(error => { relayReady = null; throw error; });
    await relayReady;
    if (signal?.aborted) throw new CheckError("检测已取消", "cancelled");
  }
  const REALMS = {
    cn: { refresh: "https://copilot.tencent.com", web: "https://www.workbuddy.cn", api: "https://www.codebuddy.cn", domain: "copilot.tencent.com" },
    intl: { refresh: "https://www.workbuddy.ai", web: "https://www.workbuddy.ai", api: "https://www.workbuddy.ai", domain: "www.workbuddy.ai" },
  };
  const SUMMARY = "/billing/meter/get-user-resource-summary";
  const RESOURCE = "/v2/billing/meter/get-user-resource";
  const ENTERPRISE = "/billing/meter/get-enterprise-user-usage";
  class CheckError extends Error {
    constructor(message, kind = "upstream") { super(message); this.kind = kind; }
  }
  function isApiKey(token) { return /^(ck_|pt_)/.test(token || ""); }
  function claims(token) {
    try {
      const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const decoded = typeof atob === "function" ? atob(part) : Buffer.from(part, "base64").toString();
      return JSON.parse(decoded);
    } catch (_) { return {}; }
  }
  function expired(token) {
    const exp = Number(claims(token).exp || 0);
    return exp > 0 && exp * 1000 <= Date.now() + 30000;
  }
  function credentialRealm(raw, fallback) {
    const realm = String(raw.realm || raw.region || fallback || "cn").toLowerCase();
    return realm === "intl" || realm === "global" ? "intl" : "cn";
  }
  function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function layers(raw) {
    return [raw, raw?.auth, raw?.auth_raw, raw?.tokens, raw?.tokenData, raw?.credentials,
      raw?.account, raw?.profile, raw?.profile_raw, raw?.user, raw?.userInfo, raw?.data].filter(object);
  }
  function pick(raw, ...keys) {
    for (const layer of layers(raw)) for (const key of keys) {
      const value = layer[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
  }
  function hasToken(raw) {
    return layers(raw).some(layer => ["accessToken", "access_token", "token"].some(key =>
      layer[key] !== undefined && layer[key] !== null && layer[key] !== ""));
  }
  function realmEvidence(value) {
    let host;
    try { host = new URL(String(value).includes("://") ? value : "https://" + value).hostname.toLowerCase(); }
    catch (_) { return ""; }
    for (const [realm, domains] of Object.entries({cn: ["copilot.tencent.com", "codebuddy.cn", "workbuddy.cn"], intl: ["workbuddy.ai", "codebuddy.ai"]})) {
      if (domains.some(domain => host === domain || host.endsWith("." + domain))) return realm;
    }
    return "";
  }
  function epoch(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? (n > 1e11 ? n / 1000 : n) : 0; }
  function normalizeCredential(raw, fallbackRealm) {
    if (!object(raw)) throw new CheckError("凭证必须是 JSON 对象", "input");
    const token = pick(raw, "accessToken", "access_token", "token");
    if (!token) throw new CheckError("未找到 accessToken 或 access_token", "input");
    const decoded = claims(token);
    const domain = pick(raw, "domain") || (object(raw.profile_raw?.sso) ? pick(raw.profile_raw.sso, "domain") : "");
    const realm = isApiKey(token) ? "cn" : realmEvidence(decoded.iss) || realmEvidence(domain) ||
      credentialRealm({realm: pick(raw, "realm", "region")}, fallbackRealm);
    const result = {
      uid: pick(raw, "uid", "userId", "user_id") || String(decoded.sub || ""), accessToken: token,
      refreshToken: pick(raw, "refreshToken", "refresh_token"), realm,
      domain: domain && realmEvidence(domain) && realmEvidence(domain) !== realm ? REALMS[realm].domain : domain,
      enterpriseId: pick(raw, "enterpriseId", "enterprise_id") || String(decoded.enterprise_id || ""),
      nickname: pick(raw, "nickname", "name", "email"),
    };
    const expiresAt = epoch(decoded.exp) || epoch(pick(raw, "expiresAt", "expires_at"));
    if (expiresAt) result.expiresAt = expiresAt;
    return result;
  }
  function parseCredentials(text, fallbackRealm) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new CheckError("请先粘贴或导入凭证", "input");
    let value;
    try { value = JSON.parse(trimmed); }
    catch (_) { value = trimmed.split(/\r?\n/).filter(line => line.trim()).map((line, index) => { try { return JSON.parse(line); } catch (_) { throw new CheckError("第 " + (index + 1) + " 行不是有效 JSON", "input"); } }); }
    const objects = isInventoryDocument(value) ? value.accounts : Array.isArray(value) ? value : [value];
    if (!Array.isArray(objects)) throw new CheckError("账号清单的 accounts 必须是数组", "input");
    if (!objects.length) throw new CheckError("没有找到有效凭证", "input");
    return objects.map(raw => normalizeCredential(raw, fallbackRealm));
  }
  function headers(account, extra) {
    const cfg = REALMS[account.realm];
    const result = { Accept: "application/json, text/plain, */*", "Content-Type": "application/json",
      Authorization: "Bearer " + account.accessToken, "X-Requested-With": "XMLHttpRequest", "X-Client-Platform": "web",
      "X-User-Id": account.uid, "X-Domain": account.domain || cfg.domain, "X-CodeBuddy-Request": "1",
      "Accept-Language": account.realm === "intl" ? "en-US" : "zh-CN" };
    if (account.enterpriseId) { result["X-Enterprise-Id"] = account.enterpriseId; result["X-Tenant-Id"] = account.enterpriseId; }
    else result["X-No-Enterprise-Id"] = "1";
    if (account.realm === "cn") result["X-Product"] = "SaaS";
    if (isApiKey(account.accessToken)) result["X-API-Key"] = account.accessToken;
    for (const [key, value] of Object.entries(extra || {})) {
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  function relayURL(url) {
    const target = new URL(url);
    for (const [realm, cfg] of Object.entries(REALMS)) {
      const routes = { profile: cfg.web + "/console/account", summary: cfg.api + SUMMARY,
        resource: cfg.api + RESOURCE, enterprise: cfg.api + ENTERPRISE,
        "enterprise-key": cfg.api + "/v2" + ENTERPRISE, refresh: cfg.refresh + "/v2/plugin/auth/token/refresh" };
      for (const [action, upstream] of Object.entries(routes)) if (target.href === upstream) return localURL("api/" + realm + "/" + action);
    }
    throw new CheckError("不支持的官方接口", "input");
  }
  async function request(url, options, fetchImpl) {
    const fetcher = fetchImpl || globalThis.fetch;
    if (typeof fetcher !== "function") throw new CheckError("当前浏览器不支持网络请求", "network");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), 20000);
    const signal = options.signal;
    const abort = () => controller.abort(signal.reason);
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }
    try {
      let response;
      try { response = await fetcher(relayURL(url), { ...options, headers: { ...options.headers, "X-WB-Pulse": "1" }, signal: controller.signal, mode: "same-origin", cache: "no-store", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" }); }
      catch (error) {
        if (signal && signal.aborted) throw new CheckError("检测已取消", "cancelled");
        if (controller.signal.aborted) throw new CheckError("请求超时，请稍后重试", "network");
        throw new CheckError("无法连接当前站点，请检查网络或服务器状态", "network");
      }
      if (!response.ok) {
        let kind = [401, 403].includes(response.status) ? "auth" : "upstream";
        let message = kind === "auth" ? "登录凭证已失效" : response.status === 404 ? "检测服务不存在，请更新部署服务器版本" : "官方接口返回 HTTP " + response.status;
        try { const body = await response.json();
          if (["network", "timeout", "busy", "redirect", "response", "origin"].includes(body.error)) {
            kind = ["network", "timeout", "busy"].includes(body.error) ? "network" : "upstream";
            message = String(body.message || message).slice(0, 160);
          }
        } catch (_) {}
        throw new CheckError(message, kind);
      }
      try { return await response.json(); } catch (_) {
        if (signal && signal.aborted) throw new CheckError("检测已取消", "cancelled");
        if (controller.signal.aborted) throw new CheckError("请求超时，请稍后重试", "network");
        throw new CheckError("官方接口返回了无法识别的数据", "upstream");
      }
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", abort); }
  }
  function ensureCode(payload) {
    if (!payload || typeof payload !== "object") throw new CheckError("接口响应格式错误", "upstream");
    if (payload.code !== undefined && Number(payload.code) !== 0) throw new CheckError("官方接口拒绝请求（code " + String(payload.code).slice(0, 20) + "）", [401, 403].includes(Number(payload.code)) ? "auth" : "upstream");
    return payload.data && typeof payload.data === "object" ? payload.data : payload;
  }
  function number(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, n) : 0; }
  function packageTotals(accounts) {
    let used = 0, size = 0;
    for (const item of accounts || []) {
      const capacity = number(item.CycleCapacitySizePrecise ?? item.CycleCapacitySize ?? item.CapacitySizePrecise ?? item.CapacitySize);
      const remain = number(item.CycleCapacityRemainPrecise ?? item.CycleCapacityRemain ?? item.CapacityRemainPrecise ?? item.CapacityRemain);
      used += number(item.CycleCapacityUsedPrecise ?? item.CycleCapacityUsed ?? item.CapacityUsedPrecise ?? item.CapacityUsed) || Math.max(0, capacity - remain);
      size += capacity;
    }
    return { used, size, remain: Math.max(0, size - used) };
  }
  function summaryCredits(data) {
    if (!Array.isArray(data.Packages)) throw new CheckError("额度摘要响应缺少套餐列表", "upstream");
    let used = 0, size = 0, remain = 0;
    for (const item of data.Packages) {
      used += number(item.CycleUsedCapacity); size += number(item.CycleTotalCapacity);
      remain += item.CycleRemainCapacity == null ? Math.max(0, number(item.CycleTotalCapacity) - number(item.CycleUsedCapacity)) : number(item.CycleRemainCapacity);
    }
    return { used, size, remain };
  }
  function identity(payload, account) {
    const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
    if (!["uid", "phoneNumber", "phone", "mobile", "email", "mail", "nickname"].some(key => data[key])) throw new CheckError("账号资料响应缺少身份信息", "upstream");
    const uid = String(data.uid || "");
    if (uid && account.uid && uid !== account.uid) throw new CheckError("账号 UID 与凭证不匹配", "upstream");
    return String(data.phoneNumber || data.phone || data.mobile || data.email || data.mail || data.nickname || account.nickname || uid || account.uid || "账号已验证");
  }
  async function refresh(account, signal, fetchImpl) {
    if (!account.refreshToken || isApiKey(account.accessToken)) throw new CheckError("登录已过期，请重新获取凭证", "auth");
    const cfg = REALMS[account.realm];
    const payload = await request(cfg.refresh + "/v2/plugin/auth/token/refresh", { method: "POST", body: "{}", signal,
      headers: headers(account, { "X-Refresh-Token": account.refreshToken, "X-Auth-Refresh-Source": account.realm === "cn" ? "workbuddy" : "plugin" }),
    }, fetchImpl);
    let data = ensureCode(payload);
    if (object(data.data)) data = ensureCode(data);
    if (typeof data.accessToken !== "string" || !data.accessToken.trim()) throw new CheckError("刷新令牌失败，请重新获取凭证", "auth");
    account.accessToken = data.accessToken;
    if (typeof data.refreshToken === "string" && data.refreshToken) account.refreshToken = data.refreshToken;
    account.expiresAt = epoch(claims(data.accessToken).exp) || epoch(data.expiresAt) ||
      (number(data.expiresIn) ? Date.now() / 1000 + number(data.expiresIn) : 0);
  }
  async function checkAccount(rawAccount, options = {}) {
    const account = Object.assign({}, rawAccount);
    const { signal, fetchImpl } = options;
    if (!REALMS[account.realm]) throw new CheckError("账号版本无效", "input");
    if (!fetchImpl) await ensureRelay(signal);
    const key = isApiKey(account.accessToken);
    let name = key ? "API Key" + (account.accessToken.includes(".") ? " · " + account.accessToken.split(".")[0].slice(0, 19) : "") : "";
    let refreshed = false;
    async function refreshOnce() {
      if (refreshed) throw new CheckError("刷新后的凭证仍不可用，请重新登录", "auth");
      refreshed = true;
      await refresh(account, signal, fetchImpl);
      // Retain rotated credentials only in the existing page-memory record, including
      // when the subsequent quota call fails. Never reuse an already consumed token.
      rawAccount.accessToken = account.accessToken;
      rawAccount.refreshToken = account.refreshToken;
      rawAccount.expiresAt = account.expiresAt;
    }
    async function authCall(fn) {
      if (signal?.aborted) throw new CheckError("检测已取消", "cancelled");
      if (!key && !refreshed && (expired(account.accessToken) || (account.expiresAt > 0 && account.expiresAt * 1000 <= Date.now() + 30000))) await refreshOnce();
      try { return ensureCode(await fn()); }
      catch (error) {
        if (error.kind !== "auth" || !account.refreshToken || key || refreshed) throw error;
        await refreshOnce();
        return ensureCode(await fn());
      }
    }
    // Confirm identity before requesting quota; this also serializes token rotation.
    if (!key) name = identity(await authCall(() => request(REALMS[account.realm].web + "/console/account", { headers: headers(account, { "Content-Type": undefined }), signal }, fetchImpl)), account);
    account.enterpriseId ||= String(claims(account.accessToken).enterprise_id || "");
    let credits;
    if (key || account.enterpriseId) {
      const route = key ? "/v2" + ENTERPRISE : ENTERPRISE;
      const data = await authCall(() => request(REALMS[account.realm].api + route, { method: "POST", headers: headers(account), body: "{}", signal }, fetchImpl));
      if (data.credit == null || data.limitNum == null) throw new CheckError("企业额度响应缺少用量字段", "upstream");
      const used = number(data.credit), size = number(data.limitNum);
      credits = { used, size, remain: Math.max(0, size - used) };
    } else {
      try {
        credits = summaryCredits(await authCall(() => request(REALMS[account.realm].api + SUMMARY, { method: "POST", headers: headers(account), body: "{}", signal }, fetchImpl)));
      } catch (error) { if (["auth", "cancelled", "network", "deployment"].includes(error.kind)) throw error; }
      if (!credits || credits.size <= 0) {
        const data = await authCall(() => {
          const now = new Date();
          const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace("T", " ");
          return request(REALMS[account.realm].api + RESOURCE, { method: "POST", headers: headers(account), signal,
            body: JSON.stringify({ PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3], PackageEndTimeRangeBegin: stamp, PackageEndTimeRangeEnd: "2036-01-01 00:00:00" }) }, fetchImpl);
        });
        const packages = data.Response?.Data?.Accounts ?? data.Accounts;
        if (!Array.isArray(packages)) throw new CheckError("资源包响应缺少额度列表", "upstream");
        credits = packageTotals(packages);
      }
    }
    return { identity: name, used: credits.used, size: credits.size, remain: credits.remain ?? Math.max(0, credits.size - credits.used), realm: account.realm };
  }
  function isInventoryDocument(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      (Object.hasOwn(value, "accounts") || (typeof value.source === "string" && /^wb[\s_-]*proxy[\s_-]*center$/i.test(value.source.trim())));
  }
  function inventoryRow(raw, index, fallbackRealm) {
    const at = "账号清单 accounts[" + index + "]";
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CheckError(at + " 必须是对象", "input");
    const uid = typeof raw.uid === "string" ? raw.uid.trim() : Number.isSafeInteger(raw.uid) ? String(raw.uid) : "";
    if (!uid) throw new CheckError(at + " 缺少有效的 uid", "input");
    const ts = raw.expiresAt;
    const ms = typeof ts === "number" && ts > 0 ? (ts < 1e11 ? ts * 1000 : ts) : NaN;
    // Only records without credentials stay in the offline inventory.
    return { uid, name: typeof raw.name === "string" ? raw.name.trim() : "", realm: credentialRealm(raw, fallbackRealm),
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : null,
      expiresAt: Number.isFinite(new Date(ms).getTime()) ? ms : null };
  }
  async function parseImportAsync(text, fallbackRealm, onProgress = () => {}) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new CheckError("请先粘贴或导入凭证", "input");
    let value;
    try { value = JSON.parse(trimmed); }
    catch (_) {
      if (trimmed.startsWith("[")) throw new CheckError("JSON 数组格式错误，请检查凭证文件", "input");
    }
    if (value !== undefined) {
      const inventory = isInventoryDocument(value);
      const objects = inventory ? value.accounts : Array.isArray(value) ? value : [value];
      if (!Array.isArray(objects)) throw new CheckError("账号清单的 accounts 必须是数组", "input");
      if (!objects.length) throw new CheckError(inventory ? "账号清单为空，没有可导入的记录" : "没有找到有效凭证", "input");
      const rows = [], inventoryRows = [];
      for (let i = 0; i < objects.length; i++) {
        try {
          if (inventory && !hasToken(objects[i])) inventoryRows.push(inventoryRow(objects[i], i, fallbackRealm));
          else rows.push(normalizeCredential(objects[i], fallbackRealm));
        } catch (error) {
          if (inventory && !error.message.startsWith("账号清单 accounts[")) throw new CheckError("账号清单 accounts[" + i + "]: " + error.message, "input");
          throw error;
        }
        if ((i + 1) % 500 === 0 && i + 1 < objects.length) {
          onProgress((i + 1) / objects.length);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      onProgress(1);
      if (!rows.length) return { kind: "inventory", rows: inventoryRows };
      return inventoryRows.length ? { kind: "mixed", rows, inventoryRows } : { kind: "credentials", rows };
    }
    const accounts = [];
    let line = 0, offset = 0;
    while (offset < trimmed.length) {
      const batchEnd = Math.min(trimmed.length, offset + 256 * 1024);
      let end = trimmed.lastIndexOf("\n", batchEnd);
      if (batchEnd === trimmed.length) end = trimmed.length;
      else if (end <= offset) { end = trimmed.indexOf("\n", batchEnd); if (end < 0) end = trimmed.length; }
      for (const row of trimmed.slice(offset, end).split(/\r?\n/)) {
        line++;
        if (!row.trim()) continue;
        let raw;
        try { raw = JSON.parse(row); } catch (_) { throw new CheckError("第 " + line + " 行不是有效 JSON", "input"); }
        accounts.push(normalizeCredential(raw, fallbackRealm));
      }
      offset = end < trimmed.length && trimmed[end] === "\n" ? end + 1 : end;
      onProgress(Math.min(1, offset / trimmed.length));
      if (offset < trimmed.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!accounts.length) throw new CheckError("没有找到有效凭证", "input");
    return { kind: "credentials", rows: accounts };
  }
  async function parseCredentialsAsync(text, fallbackRealm, onProgress) {
    const result = await parseImportAsync(text, fallbackRealm, onProgress);
    if (result.kind === "inventory") throw new CheckError("账号清单不是在线凭证", "input");
    return result.rows;
  }

  export { REALMS, CheckError, parseImportAsync, parseCredentials, parseCredentialsAsync, normalizeCredential, checkAccount, relayURL, isApiKey, expired, packageTotals, summaryCredits };
