import test from "node:test";
import assert from "node:assert/strict";
import { parseCredentials, parseCredentialsAsync, checkAccount, relayURL, CheckError } from "../web/src/api.js";
import { runPool } from "../web/src/pool.js";

function jwt(payload) {
  const part = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return "eyJhbGciOiJub25lIn0." + part + ".signature";
}
function json(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function apiFetch(handler) {
  return async (url, options) => {
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.mode, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers["X-WB-Pulse"], "1");
    assert.match(url, /^api\/(cn|intl)\//);
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal(options.headers.Authorization.startsWith("Bearer "), true);
    return handler(url, options);
  };
}

test("parser accepts JSONL, arrays, snake case and per-account realm", () => {
  const one = parseCredentials('{"uid":"u1","access_token":"a","refresh_token":"r"}', "cn")[0];
  assert.deepEqual(one, { uid: "u1", accessToken: "a", refreshToken: "r", realm: "cn", domain: "", enterpriseId: "", nickname: "" });
  const many = parseCredentials('[{"accessToken":"a"},{"accessToken":"b","realm":"intl"}]', "cn");
  assert.equal(many.length, 2); assert.equal(many[1].realm, "intl");
});
test("parser adapts account/auth wrapper exported by desktop tools", () => {
  const [credential] = parseCredentials(JSON.stringify({
    account: { uid: "nested-uid", nickname: "nested-name", enterpriseId: "enterprise" },
    auth: { accessToken: "nested-access", refreshToken: "nested-refresh", realm: "intl", domain: "example.com" },
  }));
  assert.deepEqual(credential, { uid: "nested-uid", nickname: "nested-name", enterpriseId: "enterprise", accessToken: "nested-access", refreshToken: "nested-refresh", realm: "intl", domain: "example.com" });
});
test("parser adapts exported arrays and TXT content with nested token containers", () => {
  const text = JSON.stringify([{ id: "export-id", uid: "u1", access_token: "snake", refresh_token: "refresh" }]);
  const snake = parseCredentials(text)[0];
  assert.equal(snake.uid, "u1"); assert.equal(snake.accessToken, "snake"); assert.equal(snake.refreshToken, "refresh");
  const [nested] = parseCredentials(JSON.stringify({ user: { user_id: "u2" }, credentials: { access_token: "a", refresh_token: "r", region: "global" } }));
  assert.equal(nested.uid, "u2"); assert.equal(nested.accessToken, "a"); assert.equal(nested.realm, "intl");
});
test("parser rejects missing tokens, invalid JSON and empty input", () => {
  for (const text of ["", '{"uid":"no-token"}', '{bad', "null", "[]"]) assert.throws(() => parseCredentials(text), CheckError);
});
test("personal check reads profile and CN summary", async () => {
  const urls = [];
  const result = await checkAccount(parseCredentials('{"uid":"u1","accessToken":"token"}')[0], { fetchImpl: apiFetch((url) => {
    urls.push(url);
    if (url.endsWith("/profile")) return json({ code: 0, data: { uid: "u1", phoneNumber: "13800138000", email: "user@example.com" } });
    if (url.endsWith("/summary")) return json({ code: 0, data: { Packages: [{ CycleUsedCapacity: 25, CycleTotalCapacity: 100 }, { CycleUsedCapacity: 5, CycleTotalCapacity: 200 }] } });
    throw new Error("unexpected request " + url);
  }) });
  assert.equal(result.identity, "13800138000"); assert.equal(result.used, 30); assert.equal(result.size, 300); assert.equal(result.remain, 270);
  assert.equal(urls.length, 2);
});
test("zero summary falls back to international resource packages", async () => {
  const result = await checkAccount(parseCredentials('{"accessToken":"token","realm":"intl","nickname":"user@example.com"}')[0], { fetchImpl: apiFetch((url) => {
    if (url.endsWith("/profile")) return json({ data: { email: "user@example.com" } });
    if (url.endsWith("/summary")) return json({ code: 0, data: { Packages: [] } });
    return json({ code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacitySize: 500, CycleCapacityRemain: 125 }] } } } });
  }) });
  assert.equal(result.used, 375); assert.equal(result.size, 500);
});
test("expired JWT refreshes once for profile and quota", async () => {
  let refreshes = 0;
  const token = jwt({ exp: Math.floor(Date.now() / 1000) - 10 });
  const result = await checkAccount(parseCredentials(JSON.stringify({ accessToken: token, refreshToken: "r", nickname: "old" }))[0], { fetchImpl: apiFetch((url, options) => {
    if (url.endsWith("/refresh")) { refreshes++; assert.equal(options.headers["X-Refresh-Token"], "r"); return json({ data: { accessToken: "fresh", refreshToken: "r2" } }); }
    assert.equal(options.headers.Authorization, "Bearer fresh");
    if (url.endsWith("/profile")) return json({ data: { email: "new@example.com" } });
    return json({ code: 0, data: { Packages: [{ CycleUsedCapacity: 2, CycleTotalCapacity: 10 }] } });
  }) });
  assert.equal(refreshes, 1); assert.equal(result.identity, "new@example.com");
});
test("API key uses enterprise endpoint and never exposes the secret", async () => {
  const result = await checkAccount(parseCredentials('{"accessToken":"ck_identifier.supersecret"}')[0], { fetchImpl: apiFetch((url, options) => {
    assert.equal(url, "api/cn/enterprise-key");
    assert.equal(options.headers["X-API-Key"], "ck_identifier.supersecret");
    return json({ code: 0, data: { credit: 10, limitNum: 40 } });
  }) });
  assert.equal(result.identity, "API Key · ck_identifier"); assert.equal(result.used, 10); assert.equal(result.size, 40);
});
test("network failures are reported without leaking credentials", async () => {
  await assert.rejects(checkAccount(parseCredentials('{"accessToken":"private-token"}')[0], { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }), error => {
    assert.equal(error.kind, "network"); assert.equal(error.message.includes("private-token"), false); assert.match(error.message, /无法连接当前站点/); return true;
  });
});
test("UID mismatch rejects an account", async () => {
  await assert.rejects(checkAccount(parseCredentials('{"uid":"expected","accessToken":"token"}')[0], { fetchImpl: apiFetch(url => url.endsWith("/profile") ? json({ data: { uid: "different" } }) : json({ code: 0, data: { Packages: [] } })) }), /UID/);
});
test("eight-worker pool maintains its cap and records failures", async () => {
  let active = 0, maximum = 0;
  const results = await runPool(Array.from({ length: 40 }, (_, n) => n), async (n) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, n % 3));
    active--; if (n % 7 === 0) throw new CheckError("bad"); return n;
  }, async () => {});
  assert.equal(maximum, 8); assert.equal(results.filter(x => x.status === "success").length, 34); assert.equal(results.filter(x => x.status === "failed").length, 6);
});
test("pool marks queued and active work cancelled", async () => {
  const controller = new AbortController();
  let active = 0;
  const result = await runPool([1, 2, 3, 4], async (_, signal) => {
    active++;
    if (active === 2) controller.abort();
    await new Promise(resolve => setTimeout(resolve, 5));
    if (signal.aborted) throw new CheckError("cancel", "cancelled");
    return true;
  }, async () => {}, 2, controller.signal);
  assert.ok(result.every(x => x.status === "cancelled"));
});

test("relay routes allow only exact official endpoints", () => {
  assert.equal(relayURL("https://www.workbuddy.cn/console/account"), "api/cn/profile");
  assert.equal(relayURL("https://www.workbuddy.ai/v2/billing/meter/get-enterprise-user-usage"), "api/intl/enterprise-key");
  for (const url of ["https://evil.example/console/account", "http://www.workbuddy.cn/console/account", "https://www.workbuddy.cn/console/account?url=https://evil.example"]) assert.throws(() => relayURL(url));
});
test("relay network failures surface a deployment diagnostic", async () => {
  await assert.rejects(checkAccount(parseCredentials('{"accessToken":"token"}')[0], { fetchImpl: apiFetch(() => json({ error: "network", message: "服务器无法连接官方接口，请检查部署服务器网络" }, 502)) }), /部署服务器网络/);
});
test("cancelled queued items notify the UI", async () => {
  const controller = new AbortController(); controller.abort(); const updates = [];
  const results = await runPool([1, 2, 3], async () => { throw new Error("must not run"); }, async (index, status) => updates.push([index, status]), 2, controller.signal);
  assert.equal(updates.length, 3); assert.ok(results.every(item => item.status === "cancelled"));
});

test("origin rejection is not misreported as expired credentials or refreshed", async () => {
  const urls = [];
  await assert.rejects(checkAccount(parseCredentials('{"accessToken":"token","refreshToken":"refresh"}')[0], { fetchImpl: apiFetch(url => {
    urls.push(url); return json({ error: "origin", message: "请求来源不匹配" }, 403);
  }) }), error => error.kind === "upstream" && error.message === "请求来源不匹配");
  assert.ok(urls.every(url => !url.endsWith("/refresh")));
});
test("cancellation during response body reading stays cancelled", async () => {
  const controller = new AbortController();
  await assert.rejects(checkAccount(parseCredentials('{"accessToken":"ck_fixture.secret"}')[0], { signal: controller.signal, fetchImpl: apiFetch(() => ({ ok: true, status: 200, json: async () => { controller.abort(); throw new Error("aborted stream"); } })) }), error => error.kind === "cancelled");
});

test("credential import has no account cap and reports incremental progress", async () => {
  const credentials = Array.from({ length: 5005 }, (_, i) => JSON.stringify({ uid: `bulk-${i}`, accessToken: `synthetic-${i}`, realm: i % 2 ? "cn" : "intl" })).join("\n");
  const progress = [];
  const parsed = await parseCredentialsAsync(credentials, "cn", ratio => progress.push(ratio));
  assert.equal(parsed.length, 5005);
  assert.equal(parsed[4999].uid, "bulk-4999");
  assert.equal(parsed[5004].realm, "intl");
  assert.ok(progress.length > 1);
  assert.equal(progress.at(-1), 1);
  assert.equal(parseCredentials(credentials).length, 5005);
});

test("empty JSON arrays and malformed entries fail with clear input errors", async () => {
  await assert.rejects(parseCredentialsAsync("[]"), /没有找到有效凭证/);
  await assert.rejects(parseCredentialsAsync('{"accessToken":"ok"}\n{bad'), /第 2 行/);
});


test('upstream-style normalization recovers realm, UID, raw metadata and expiry without trusting stale realm', () => {
  const token = jwt({sub:'derived',iss:'https://www.codebuddy.cn/auth',exp:2000000000,enterprise_id:'team'});
  const [row] = parseCredentials(JSON.stringify([{access_token:token,refresh_token:'r',expires_at:1,
    realm:'intl',auth_raw:{domain:'www.workbuddy.ai'},profile_raw:{nickname:'Raw name'}}]), 'intl');
  assert.equal(row.uid,'derived'); assert.equal(row.realm,'cn'); assert.equal(row.domain,'copilot.tencent.com');
  assert.equal(row.nickname,'Raw name'); assert.equal(row.enterpriseId,'team'); assert.equal(row.expiresAt,2000000000);
  const [raw] = parseCredentials(JSON.stringify({auth_raw:{accessToken:'opaque',domain:'www.codebuddy.cn'},profile_raw:{uid:'raw'}}),'intl');
  assert.equal(raw.uid,'raw'); assert.equal(raw.realm,'cn'); assert.equal(raw.domain,'www.codebuddy.cn');
});
test('domain inference ignores lookalike suffixes and respects explicit region without evidence', () => {
  assert.equal(parseCredentials(JSON.stringify({accessToken:'opaque',domain:'codebuddy.cn.attacker.test',realm:'intl'}))[0].realm,'intl');
  assert.equal(parseCredentials(JSON.stringify({accessToken:'ck_id.secret',realm:'intl'}))[0].realm,'cn');
});
test('business-code authentication failures refresh and persist rotation for subsequent checks', async () => {
  const row = parseCredentials(' {"uid":"u","accessToken":"old","refreshToken":"r1"} ')[0];
  let refreshes=0; const calls=[];
  const fetchImpl=apiFetch((url,options)=>{
    calls.push(url);
    if(url.endsWith('/refresh')) {refreshes++;assert.equal(options.headers['X-Refresh-Token'],'r1'); return json({code:0,data:{data:{accessToken:'fresh',refreshToken:'r2'}}});}
    if(options.headers.Authorization==='Bearer old')return json({code:401,msg:'synthetic-private-upstream-message'});
    if(url.endsWith('/profile'))return json({code:0,data:{uid:'u'}});
    return json({code:0,data:{Packages:[{CycleTotalCapacity:100,CycleUsedCapacity:10,CycleRemainCapacity:85}]}});
  });
  const result=await checkAccount(row,{fetchImpl});
  assert.equal(refreshes,1);assert.equal(row.accessToken,'fresh');assert.equal(row.refreshToken,'r2');assert.equal(result.remain,85);
  assert.ok(calls.indexOf('api/cn/summary')>calls.lastIndexOf('api/cn/profile'));
  await checkAccount(row,{fetchImpl});assert.equal(refreshes,1);
  assert.equal(relayURL('https://copilot.tencent.com/v2/plugin/auth/token/refresh'),'api/cn/refresh');
});
test('refresh rotation survives quota failure, but failed refresh never mutates credentials', async () => {
  const row=parseCredentials(JSON.stringify({accessToken:jwt({exp:1}),refreshToken:'r'}))[0];
  await assert.rejects(checkAccount(row,{fetchImpl:apiFetch(url=>{
    if(url.endsWith('/refresh')) return json({data:{accessToken:'rotated',refreshToken:'rotated-refresh'}});
    if(url.endsWith('/profile'))return json({data:{nickname:'ok'}});
    return json({},500);
  })}));
  assert.equal(row.refreshToken,'rotated-refresh');
  const bad=parseCredentials(JSON.stringify({accessToken:jwt({exp:1}),refreshToken:'unchanged'}))[0];
  await assert.rejects(checkAccount(bad,{fetchImpl:apiFetch(()=>json({code:401,data:{accessToken:'must-not-apply'}}))}),err=>err.kind==='auth');
  assert.equal(bad.refreshToken,'unchanged');assert.notEqual(bad.accessToken,'must-not-apply');
});
test('missing profile or quota fields are not reported as healthy zero balance', async () => {
  await assert.rejects(checkAccount(parseCredentials('{"accessToken":"opaque"}')[0],{fetchImpl:apiFetch(()=>json({code:0,data:{}}))}),/身份信息/);
  await assert.rejects(checkAccount(parseCredentials('{"accessToken":"opaque"}')[0],{fetchImpl:apiFetch(url=>json({data:url.endsWith('/profile')?{uid:'u'}:{}}))}),/额度列表/);
  await assert.rejects(checkAccount(parseCredentials('{"accessToken":"ck_id.secret"}')[0],{fetchImpl:apiFetch(()=>json({data:{}}))}),/用量字段/);
});
test('enterprise claims supply both tenant headers and select enterprise quota', async () => {
  const row=parseCredentials(JSON.stringify({accessToken:jwt({sub:'u',enterprise_id:'tenant'})}))[0];
  const result=await checkAccount(row,{fetchImpl:apiFetch((url,options)=>{
    assert.equal(options.headers['X-Enterprise-Id'],'tenant');assert.equal(options.headers['X-Tenant-Id'],'tenant');
    if(url.endsWith('/profile'))return json({data:{uid:'u'}});
    assert.equal(url,'api/cn/enterprise');return json({data:{credit:2,limitNum:10}});
  })});assert.equal(result.remain,8);
});
