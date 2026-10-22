"use strict";
// AI Key 本地存储：加密落盘、打码返回、编辑留空沿用原 Key、删除与默认配置
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildSync } = require("esbuild");
const outDir = path.join(__dirname, "../test/.cache");
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, "aiKeyStore.cjs");
buildSync({ entryPoints: [path.join(__dirname, "../src/main/services/aiKeyStore.js")],
  bundle: true, platform: "node", format: "cjs", outfile });
const { createAiKeyStore } = require(outfile);

// 模拟 Electron safeStorage：简单可逆变换，验证文件中不出现明文
const fakeSafeStorage = {
  available: true,
  isEncryptionAvailable() { return this.available; },
  encryptString: (s) => Buffer.from("ENC:" + Buffer.from(s).reverse().toString("hex")),
  decryptString: (b) => Buffer.from(b.toString().slice(4), "hex").reverse().toString(),
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-ai-"));
const filePath = path.join(dir, "sub", "ai-settings.json");
const store = createAiKeyStore({ filePath, safeStorage: fakeSafeStorage });
const KEY1 = "sk-deepseek-SECRET-1111";
const KEY2 = "sk-qwen-SECRET-2222";

assert.deepStrictEqual(store.list(), { providers: [], defaultId: "", secureStorage: true });
assert.throws(() => store.resolve(), /还没有配置 AI 接口/);
assert.throws(() => store.save({ name: "A", baseURL: "https://a.com/v1", model: "m" }), /请填写 API Key/);

const p1 = store.save({ name: "DeepSeek", preset: "deepseek", baseURL: "https://api.deepseek.com/v1/", model: "deepseek-chat", apiKey: KEY1 });
assert.ok(p1.id);
assert.strictEqual(p1.isDefault, true, "第一条配置自动设为默认");
assert.strictEqual(p1.baseURL, "https://api.deepseek.com/v1");
assert.ok(!JSON.stringify(p1).includes(KEY1), "返回给界面的数据不含明文 Key");
assert.ok(p1.maskedKey.endsWith("1111"));

const raw = fs.readFileSync(filePath, "utf8");
assert.ok(!raw.includes(KEY1), "配置文件中不出现明文 Key");
assert.ok(raw.includes('"enc": "safeStorage"'));
if (process.platform !== "win32") {
  assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600, "配置文件权限为 0600");
}
assert.strictEqual(fs.readdirSync(path.dirname(filePath)).filter((f) => f.endsWith(".tmp")).length, 0);

const p2 = store.save({ name: "千问", preset: "qwen", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", apiKey: KEY2 });
let listed = store.list();
assert.strictEqual(listed.providers.length, 2);
assert.strictEqual(listed.defaultId, p1.id);
assert.ok(!JSON.stringify(listed).includes(KEY2));

// resolve 默认 / 指定
assert.strictEqual(store.resolve().apiKey, KEY1);
assert.strictEqual(store.resolve(p2.id).apiKey, KEY2);

// 编辑：Key 留空沿用原 Key，其他字段更新
store.save({ id: p2.id, name: "千问-改", preset: "qwen", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-max", apiKey: "" });
assert.strictEqual(store.resolve(p2.id).apiKey, KEY2);
assert.strictEqual(store.resolve(p2.id).model, "qwen-max");
// 编辑：填新 Key 则替换
store.save({ id: p2.id, name: "千问-改", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-max", apiKey: "sk-new-3333", setDefault: true });
assert.strictEqual(store.resolve().apiKey, "sk-new-3333", "setDefault 生效");
assert.throws(() => store.save({ id: "nope", name: "x", baseURL: "https://a.com", model: "m", apiKey: "k" }), /不存在/);

// 设默认 / 删除默认后自动回落
store.setDefault(p1.id);
assert.strictEqual(store.list().defaultId, p1.id);
store.remove(p1.id);
listed = store.list();
assert.strictEqual(listed.providers.length, 1);
assert.strictEqual(listed.defaultId, p2.id);
assert.throws(() => store.remove(p1.id), /不存在/);
assert.throws(() => store.setDefault("nope"), /不存在/);

// 系统不支持加密：退回编码存储，并在 list 里提示
fakeSafeStorage.available = false;
const plainStore = createAiKeyStore({ filePath: path.join(dir, "plain.json"), safeStorage: fakeSafeStorage });
plainStore.save({ name: "P", baseURL: "https://a.com/v1", model: "m", apiKey: "sk-plain-4444" });
assert.strictEqual(plainStore.list().secureStorage, false);
assert.strictEqual(plainStore.resolve().apiKey, "sk-plain-4444");
// 之前用 safeStorage 加密的 Key 在加密不可用时给出明确提示，而不是返回乱码
assert.throws(() => store.resolve(), /加密存储不可用/);
assert.ok(store.list().providers[0].keyError);
fakeSafeStorage.available = true;

// 损坏文件不被覆盖
const broken = path.join(dir, "broken.json");
fs.writeFileSync(broken, "{oops");
const brokenStore = createAiKeyStore({ filePath: broken, safeStorage: fakeSafeStorage });
assert.throws(() => brokenStore.list(), /已损坏/);
assert.throws(() => brokenStore.save({ name: "a", baseURL: "https://a.com", model: "m", apiKey: "k" }), /已损坏/);
assert.strictEqual(fs.readFileSync(broken, "utf8"), "{oops");

fs.rmSync(dir, { recursive: true, force: true });
console.log("test-ai-key-store: 全部断言通过");
