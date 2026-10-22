"use strict";
// AI IPC 端到端：来源校验 + 真实 axios 请求本地 OpenAI 兼容模拟服务（生成、测试连接、错误打码）
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildSync } = require("esbuild");
const { createMockServer, VALID_KEY } = require("./ai-mock-server.js");
const outDir = path.join(__dirname, "../test/.cache");
fs.mkdirSync(outDir, { recursive: true });
function load(entry, name) {
  const outfile = path.join(outDir, name);
  buildSync({ entryPoints: [path.join(__dirname, entry)], bundle: true, platform: "node", format: "cjs", outfile });
  return require(outfile);
}
const { registerAiContentIpc } = load("../src/main/services/aiContentIpc.js", "aiContentIpc.cjs");
const { createAiKeyStore } = load("../src/main/services/aiKeyStore.js", "aiKeyStore.cjs");

async function main() {
  const server = createMockServer({ delayMs: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-ai-ipc-"));
  const store = createAiKeyStore({ filePath: path.join(dir, "ai-settings.json"), safeStorage: null });
  const handlers = new Map();
  registerAiContentIpc({ handle: (n, h) => handlers.set(n, h) }, { store });
  const call = (name, ...args) => handlers.get(name)({ senderFrame: { url: "file:///app/index.html" } }, ...args);
  const allOutputs = [];
  const callLogged = async (...a) => { const r = await call(...a); allOutputs.push(r); return r; };

  // 外部页面一律拒绝，且不触发任何请求
  for (const url of ["https://creator.douyin.com/", "http://localhost.evil/", "file://remote/x", ""]) {
    for (const name of handlers.keys()) {
      const res = await handlers.get(name)({ senderFrame: { url } }, {});
      assert.strictEqual(res.ok, false, `${name} 应拒绝 ${url}`);
    }
  }
  assert.strictEqual(server.requests.length, 0);

  // 未配置时生成给出引导
  let res = await callLogged("ai:generate", { kind: "title", context: { name: "爬山" } });
  assert.strictEqual(res.ok, false);
  assert.ok(/AI 设置/.test(res.message));

  // 测试未保存的表单：错 Key -> 401 且错误信息中 Key 被打码
  const WRONG = "sk-wrong-key-987654";
  res = await callLogged("ai:test-provider", { baseURL, model: "mock", apiKey: WRONG });
  assert.strictEqual(res.ok, false);
  assert.ok(/API Key 无效/.test(res.message));
  assert.ok(!res.message.includes(WRONG), "错误提示不能回显完整 Key");
  // 对 Key 正确
  res = await callLogged("ai:test-provider", { baseURL, model: "mock", apiKey: VALID_KEY });
  assert.strictEqual(res.ok, true);
  assert.ok(typeof res.latencyMs === "number");

  // 保存配置
  res = await callLogged("ai:save-provider", { name: "Mock", preset: "custom", baseURL: baseURL + "/", model: "mock-model", apiKey: VALID_KEY });
  assert.strictEqual(res.ok, true);
  const id = res.provider.id;
  assert.strictEqual(res.providers.length, 1);

  // 测试已保存配置（只传 id，Key 不出主进程）
  res = await callLogged("ai:test-provider", { id });
  assert.strictEqual(res.ok, true);
  // 编辑表单测试：Key 留空沿用已保存 Key
  res = await callLogged("ai:test-provider", { id, name: "Mock", baseURL, model: "mock-model", apiKey: "" });
  assert.strictEqual(res.ok, true);

  // 生成三类内容
  const ctx = { contentType: "video", name: "周末爬山vlog", title: "", body: "", tags: ["户外"] };
  res = await callLogged("ai:generate", { kind: "title", context: ctx });
  assert.strictEqual(res.ok, true, res.message);
  assert.strictEqual(res.value, "周末爬山⛰️看到了最美的日落");
  assert.strictEqual(res.model, "mock-model");
  res = await callLogged("ai:generate", { kind: "body", context: ctx });
  assert.strictEqual(res.ok, true, res.message);
  assert.ok(res.value.includes("山顶的日落"));
  res = await callLogged("ai:generate", { kind: "tags", context: ctx });
  assert.strictEqual(res.ok, true, res.message);
  assert.deepStrictEqual(res.value, ["周末去哪儿", "户外徒步", "治愈系风景", "城市周边游", "vlog日常"]);

  // 请求确实带 Bearer Key、模型和素材
  const last = server.requests[server.requests.length - 1];
  assert.strictEqual(last.headers.authorization, `Bearer ${VALID_KEY}`);
  assert.strictEqual(last.body.model, "mock-model");
  assert.ok(last.body.messages[1].content.includes("周末爬山vlog"));

  // 指定 providerId：第二个配置（非默认）生成时用它的模型；不存在的 id 明确报错
  res = await callLogged("ai:save-provider", { name: "Mock2", preset: "custom", baseURL, model: "mock-model-2", apiKey: VALID_KEY });
  assert.strictEqual(res.ok, true);
  const id2 = res.provider.id;
  assert.strictEqual(res.provider.isDefault, false);
  res = await callLogged("ai:generate", { kind: "title", context: ctx, providerId: id2 });
  assert.strictEqual(res.ok, true, res.message);
  assert.strictEqual(res.model, "mock-model-2");
  assert.strictEqual(res.providerId, id2);
  assert.strictEqual(server.requests[server.requests.length - 1].body.model, "mock-model-2");
  res = await callLogged("ai:generate", { kind: "title", context: ctx });
  assert.strictEqual(res.model, "mock-model", "不传 providerId 时用默认配置");
  res = await callLogged("ai:generate", { kind: "title", context: ctx, providerId: "no-such-id" });
  assert.strictEqual(res.ok, false);
  assert.ok(/不存在/.test(res.message));
  await callLogged("ai:delete-provider", id2);

  // 取消：慢请求进行中调用 ai:cancel-generate，生成立即以 canceled 结束
  server.delayMs = 5000;
  const started = Date.now();
  const pendingGen = callLogged("ai:generate", { kind: "title", context: ctx, requestId: "req-1" });
  await new Promise((r) => setTimeout(r, 100));
  const cancelRes = await callLogged("ai:cancel-generate", "req-1");
  assert.strictEqual(cancelRes.ok, true);
  assert.strictEqual(cancelRes.canceled, true);
  res = await pendingGen;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.canceled, true);
  assert.ok(/已取消/.test(res.message));
  assert.ok(Date.now() - started < 3000, "取消后应立即返回，而不是等到超时");
  // 已结束 / 不存在的 requestId 静默成功
  res = await callLogged("ai:cancel-generate", "req-1");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.canceled, false);
  server.delayMs = 0;

  // 参数错误 / 无素材 / 模型不存在
  assert.strictEqual((await callLogged("ai:generate", { kind: "evil", context: ctx })).ok, false);
  assert.ok(/素材/.test((await callLogged("ai:generate", { kind: "title", context: {} })).message));
  await callLogged("ai:save-provider", { id, name: "Mock", baseURL, model: "missing-model", apiKey: "" });
  res = await callLogged("ai:generate", { kind: "title", context: ctx });
  assert.strictEqual(res.ok, false);
  assert.ok(/404/.test(res.message));

  // 网络不可达
  res = await callLogged("ai:test-provider", { baseURL: "http://127.0.0.1:1/v1", model: "m", apiKey: VALID_KEY });
  assert.strictEqual(res.ok, false);
  assert.ok(/无法连接/.test(res.message), res.message);

  // 删除
  res = await callLogged("ai:delete-provider", id);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.providers.length, 0);

  // 所有返回给渲染进程的数据都不含明文 Key
  const dump = JSON.stringify(allOutputs);
  assert.ok(!dump.includes(VALID_KEY), "IPC 返回值中出现了明文 Key");
  assert.ok(!dump.includes(WRONG), "IPC 返回值中出现了明文 Key");

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("test-ai-content-ipc: 全部断言通过");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
