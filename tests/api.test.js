const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCredentials, checkAccount, CheckError } = require("../internal/server/static/api.js");
const { runPool } = require("../internal/server/static/app.js");

function jwt(payload) {
  const part = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return "eyJhbGciOiJub25lIn0." + part + ".signature";
}
function json(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function apiFetch(handler) {
  return async (url, options) => {
    assert.equal(options.credentials, "omit");
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
test("parser rejects missing tokens, invalid JSON and empty input", () => {
  for (const text of ["", '{"uid":"no-token"}', '{bad', "null", "[]"]) assert.throws(() => parseCredentials(text), CheckError);
});
test("personal check reads profile and CN summary", async () => {
  const urls = [];
  const result = await checkAccount(parseCredentials('{"uid":"u1","accessToken":"token"}')[0], { fetchImpl: apiFetch((url) => {
    urls.push(url);
    if (url.endsWith("/console/account")) return json({ code: 0, data: { uid: "u1", phoneNumber: "13800138000", email: "user@example.com" } });
    if (url.endsWith("get-user-resource-summary")) return json({ code: 0, data: { Packages: [{ CycleUsedCapacity: 25, CycleTotalCapacity: 100 }, { CycleUsedCapacity: 5, CycleTotalCapacity: 200 }] } });
    throw new Error("unexpected request " + url);
  }) });
  assert.equal(result.identity, "13800138000"); assert.equal(result.used, 30); assert.equal(result.size, 300); assert.equal(result.remain, 270);
  assert.equal(urls.length, 2);
});
test("zero summary falls back to international resource packages", async () => {
  const result = await checkAccount(parseCredentials('{"accessToken":"token","realm":"intl","nickname":"user@example.com"}')[0], { fetchImpl: apiFetch((url) => {
    if (url.endsWith("/console/account")) return json({ data: { email: "user@example.com" } });
    if (url.endsWith("get-user-resource-summary")) return json({ code: 0, data: { Packages: [] } });
    return json({ code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacitySize: 500, CycleCapacityRemain: 125 }] } } } });
  }) });
  assert.equal(result.used, 375); assert.equal(result.size, 500);
});
test("expired JWT refreshes once for profile and quota", async () => {
  let refreshes = 0;
  const token = jwt({ exp: Math.floor(Date.now() / 1000) - 10 });
  const result = await checkAccount(parseCredentials(JSON.stringify({ accessToken: token, refreshToken: "r", nickname: "old" }))[0], { fetchImpl: apiFetch((url, options) => {
    if (url.endsWith("/token/refresh")) { refreshes++; assert.equal(options.headers["X-Refresh-Token"], "r"); return json({ data: { accessToken: "fresh", refreshToken: "r2" } }); }
    assert.equal(options.headers.Authorization, "Bearer fresh");
    if (url.endsWith("/console/account")) return json({ data: { email: "new@example.com" } });
    return json({ code: 0, data: { Packages: [{ CycleUsedCapacity: 2, CycleTotalCapacity: 10 }] } });
  }) });
  assert.equal(refreshes, 1); assert.equal(result.identity, "new@example.com");
});
test("API key uses enterprise endpoint and never exposes the secret", async () => {
  const result = await checkAccount(parseCredentials('{"accessToken":"ck_identifier.supersecret"}')[0], { fetchImpl: apiFetch((url, options) => {
    assert.match(url, /\/v2\/billing\/meter\/get-enterprise-user-usage$/);
    assert.equal(options.headers["X-API-Key"], "ck_identifier.supersecret");
    return json({ code: 0, data: { credit: 10, limitNum: 40 } });
  }) });
  assert.equal(result.identity, "API Key · ck_identifier"); assert.equal(result.used, 10); assert.equal(result.size, 40);
});
test("network failures are reported without leaking credentials", async () => {
  await assert.rejects(checkAccount(parseCredentials('{"accessToken":"private-token"}')[0], { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }), error => {
    assert.equal(error.kind, "network"); assert.equal(error.message.includes("private-token"), false); assert.match(error.message, /CORS/); return true;
  });
});
test("UID mismatch rejects an account", async () => {
  await assert.rejects(checkAccount(parseCredentials('{"uid":"expected","accessToken":"token"}')[0], { fetchImpl: apiFetch(url => url.endsWith("/console/account") ? json({ data: { uid: "different" } }) : json({ code: 0, data: { Packages: [] } })) }), /UID/);
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
