const assert = require("assert");
const {
  normalizeAccountProxy,
  isAccountProxyEnabled,
  getAccountProxyDisplay,
  getEnabledAccountProxies,
  pickActiveAccountProxy,
  parseProxyUrl,
} = require("../src/shared/accountProxy.js");

const legacy = normalizeAccountProxy({
  enabled: true,
  url: "127.0.0.1:7890",
});
assert.strictEqual(legacy.ok, true);
assert.deepStrictEqual(legacy.value, {
  proxies: [{ enabled: true, url: "http://127.0.0.1:7890" }],
});

const list = normalizeAccountProxy({
  proxies: [
    { enabled: true, url: "http://127.0.0.1:7890" },
    { enabled: false, url: "http://127.0.0.1:7891" },
    { enabled: true, url: "socks5://127.0.0.1:1080" },
  ],
});
assert.strictEqual(list.ok, true);
assert.deepStrictEqual(getEnabledAccountProxies(list.value), [
  { enabled: true, url: "http://127.0.0.1:7890" },
  { enabled: true, url: "socks5://127.0.0.1:1080" },
]);
assert.strictEqual(isAccountProxyEnabled(list.value), true);
assert.strictEqual(getAccountProxyDisplay(list.value), "127.0.0.1:7890 等 2 个");
assert.deepStrictEqual(pickActiveAccountProxy(list.value), {
  enabled: true,
  url: "http://127.0.0.1:7890",
});

const secondDisabled = normalizeAccountProxy({
  proxies: [
    { enabled: false, url: "http://127.0.0.1:7890" },
    { enabled: true, url: "socks5://127.0.0.1:1080" },
  ],
});
assert.strictEqual(secondDisabled.ok, true);
assert.deepStrictEqual(pickActiveAccountProxy(secondDisabled.value), {
  enabled: true,
  url: "socks5://127.0.0.1:1080",
});

const disabledOnly = normalizeAccountProxy({
  proxies: [{ enabled: false, url: "http://127.0.0.1:7890" }],
});
assert.strictEqual(disabledOnly.ok, true);
assert.strictEqual(isAccountProxyEnabled(disabledOnly.value), false);
assert.strictEqual(pickActiveAccountProxy(disabledOnly.value), null);

// 凭据里畸形的百分号编码：应返回 { ok: false, error }，而不是抛 URIError（#44）
for (const bad of [
  "http://user%:pass@proxy.invalid:8080",
  "http://user:pass%FF@proxy.invalid:8080",
  "http://%ZZ@proxy.invalid:8080",
  "http://user%2@proxy.invalid:8080",
  "http://%E4%BD@proxy.invalid:8080",
]) {
  const r = parseProxyUrl(bad);
  assert.strictEqual(r.ok, false, `${bad} 应校验失败`);
  assert.strictEqual(typeof r.error, "string", `${bad} 应带中文错误信息`);
  assert.ok(!r.error.includes("URI"), `${bad} 错误信息不应暴露内部异常`);
}
// 合法转义与中文凭据不受影响
for (const good of [
  "http://user%40x:p%23ss@proxy.invalid:8080",
  "http://%E4%B8%AD%E6%96%87:%E5%AF%86%E7%A0%81@proxy.invalid:8080",
]) {
  const r = parseProxyUrl(good);
  assert.strictEqual(r.ok, true, `${good} 应校验通过`);
  assert.ok(r.value.hasAuth);
}
// normalizeAccountProxy 链路同样不再抛异常
assert.strictEqual(
  normalizeAccountProxy({ enabled: true, url: "http://user%:pass@proxy.invalid:8080" }).ok,
  false
);

console.log("accountProxy: ok");
