/* WB Pulse: same-origin API client. The deployment server relays fixed official endpoints. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WBApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const REALMS = {
    cn: { web: "https://www.workbuddy.cn", api: "https://www.codebuddy.cn", domain: "copilot.tencent.com" },
    intl: { web: "https://www.workbuddy.ai", api: "https://www.workbuddy.ai", domain: "www.workbuddy.ai" },
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
  function normalizeCredential(raw, fallbackRealm) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CheckError("凭证必须是 JSON 对象", "input");
    // Exporters commonly wrap tokens in auth/tokens/credentials and identity in
    // account/profile/user. Prefer the token container, then merge its parents
    // for realm/domain without overriding explicitly supplied fields.
    const auth = [raw.auth, raw.tokens, raw.tokenData, raw.credentials, raw.data].find(value => value && typeof value === "object" && !Array.isArray(value) && (value.accessToken || value.access_token || value.token)) || raw;
    const profile = [raw.account, raw.profile, raw.user, raw.userInfo, raw.data].find(value => value && typeof value === "object" && !Array.isArray(value)) || {};
    const token = String(auth.accessToken || auth.access_token || auth.token || raw.accessToken || raw.access_token || raw.token || "").trim();
    if (!token) throw new CheckError("未找到 accessToken 或 access_token", "input");
    return { uid: String(profile.uid || profile.userId || profile.user_id || raw.uid || raw.userId || raw.user_id || ""), accessToken: token,
      refreshToken: String(auth.refreshToken || auth.refresh_token || raw.refreshToken || raw.refresh_token || ""), realm: credentialRealm({ ...raw, ...auth }, fallbackRealm),
      domain: String(auth.domain || raw.domain || ""), enterpriseId: String(profile.enterpriseId || profile.enterprise_id || auth.enterpriseId || auth.enterprise_id || raw.enterpriseId || raw.enterprise_id || ""),
      nickname: String(profile.nickname || profile.name || raw.nickname || raw.name || "") };
  }
  function parseCredentials(text, fallbackRealm) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new CheckError("请先粘贴或导入凭证", "input");
    let objects;
    try { const value = JSON.parse(trimmed); objects = Array.isArray(value) ? value : [value]; }
    catch (_) { objects = trimmed.split(/\r?\n/).filter(line => line.trim()).map((line, index) => { try { return JSON.parse(line); } catch (_) { throw new CheckError("第 " + (index + 1) + " 行不是有效 JSON", "input"); } }); }
    if (!objects.length) throw new CheckError("没有找到有效凭证", "input");
    if (objects.length > 2000) throw new CheckError("单次最多检测 2000 个账号", "input");
    return objects.map(raw => normalizeCredential(raw, fallbackRealm));
  }
  function headers(account, extra) {
    const cfg = REALMS[account.realm];
    const result = { Accept: "application/json, text/plain, */*", "Content-Type": "application/json",
      Authorization: "Bearer " + account.accessToken, "X-Requested-With": "XMLHttpRequest", "X-Client-Platform": "web",
      "X-User-Id": account.uid, "X-Domain": account.domain || cfg.domain, "X-CodeBuddy-Request": "1",
      "Accept-Language": account.realm === "intl" ? "en-US" : "zh-CN" };
    if (account.enterpriseId) result["X-Enterprise-Id"] = account.enterpriseId;
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
        "enterprise-key": cfg.api + "/v2" + ENTERPRISE, refresh: cfg.web + "/v2/plugin/auth/token/refresh" };
      for (const [action, upstream] of Object.entries(routes)) if (target.href === upstream) return "api/" + realm + "/" + action;
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
      try { response = await fetcher(relayURL(url), { ...options, headers: { ...options.headers, "X-WB-Pulse": "1" }, signal: controller.signal, credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" }); }
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
    if (payload.code !== undefined && Number(payload.code) !== 0) throw new CheckError("官方接口拒绝请求（code " + String(payload.code).slice(0, 20) + "）", Number(payload.code) === 401 ? "auth" : "upstream");
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
    let used = 0, size = 0;
    for (const item of data.Packages || []) { used += number(item.CycleUsedCapacity); size += number(item.CycleTotalCapacity); }
    return { used, size, remain: Math.max(0, size - used) };
  }
  function identity(payload, account) {
    const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
    const uid = String(data.uid || "");
    if (uid && account.uid && uid !== account.uid) throw new CheckError("账号 UID 与凭证不匹配", "upstream");
    return String(data.phoneNumber || data.phone || data.mobile || data.email || data.mail || data.nickname || account.nickname || uid || account.uid || "账号已验证");
  }
  async function refresh(account, signal, fetchImpl) {
    if (!account.refreshToken || isApiKey(account.accessToken)) throw new CheckError("登录已过期，请重新获取凭证", "auth");
    const cfg = REALMS[account.realm];
    const payload = await request(cfg.web + "/v2/plugin/auth/token/refresh", { method: "POST", body: "{}", signal,
      headers: headers(account, { "X-Refresh-Token": account.refreshToken, "X-Auth-Refresh-Source": account.realm === "cn" ? "workbuddy" : "plugin" }),
    }, fetchImpl);
    let data = payload.data || {};
    if (data.data) data = data.data;
    if (!data.accessToken) throw new CheckError("刷新令牌失败，请重新获取凭证", "auth");
    account.accessToken = String(data.accessToken);
    if (data.refreshToken) account.refreshToken = String(data.refreshToken);
  }
  async function checkAccount(rawAccount, options = {}) {
    const account = Object.assign({}, rawAccount);
    const { signal, fetchImpl } = options;
    if (!REALMS[account.realm]) throw new CheckError("账号版本无效", "input");
    const key = isApiKey(account.accessToken);
    const enterprise = key || Boolean(account.enterpriseId || claims(account.accessToken).enterprise_id);
    let name = key ? "API Key · " + account.accessToken.split(".")[0].slice(0, 19) : "";
    let refreshPromise = null;
    async function refreshOnce() {
      if (!refreshPromise) refreshPromise = refresh(account, signal, fetchImpl).finally(() => { refreshPromise = null; });
      return refreshPromise;
    }
    const authCall = fn => (async () => {
      if (expired(account.accessToken)) await refreshOnce();
      try { return await fn(); } catch (error) {
        if (error.kind !== "auth" || !account.refreshToken) throw error;
        await refreshOnce(); return fn();
      }
    })();
    const profilePromise = key ? null : authCall(() => request(REALMS[account.realm].web + "/console/account", { headers: headers(account, { "Content-Type": undefined }), signal }, fetchImpl)).then(payload => { name = identity(ensureCode(payload), account); });
    const creditsPromise = (async () => {
      if (enterprise) {
        const path = key ? "/v2" + ENTERPRISE : ENTERPRISE;
        const data = ensureCode(await authCall(() => request(REALMS[account.realm].api + path, { method: "POST", headers: headers(account), body: "{}", signal }, fetchImpl)));
        const used = number(data.credit), size = number(data.limitNum);
        return { used, size, remain: Math.max(0, size - used) };
      }
      try {
        const credits = summaryCredits(ensureCode(await authCall(() => request(REALMS[account.realm].api + SUMMARY, { method: "POST", headers: headers(account), body: "{}", signal }, fetchImpl))));
        if (credits.size > 0) return credits;
      } catch (error) { if (error.kind === "auth" || error.kind === "cancelled") throw error; }
      const data = ensureCode(await authCall(() => {
        const now = new Date();
        const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace("T", " ");
        return request(REALMS[account.realm].api + RESOURCE, { method: "POST", headers: headers(account), signal,
          body: JSON.stringify({ PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3], PackageEndTimeRangeBegin: stamp, PackageEndTimeRangeEnd: "2036-01-01 00:00:00" }) }, fetchImpl);
      }));
      return packageTotals((data.Response && data.Response.Data && data.Response.Data.Accounts) || data.Accounts || []);
    })();
    const values = await (profilePromise ? Promise.all([profilePromise, creditsPromise]) : Promise.all([creditsPromise]));
    const credits = values[values.length - 1];
    return { identity: name, used: credits.used, size: credits.size, remain: credits.remain ?? Math.max(0, credits.size - credits.used), realm: account.realm };
  }
  return { REALMS, CheckError, parseCredentials, normalizeCredential, checkAccount, relayURL, isApiKey, expired, packageTotals, summaryCredits };
});
