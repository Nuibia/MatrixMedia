"use strict";
// AI 生成纯逻辑：配置校验、Key 打码、提示词构造、模型输出解析
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildSync } = require("esbuild");
const outDir = path.join(__dirname, "../test/.cache");
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, "aiContent.cjs");
buildSync({ entryPoints: [path.join(__dirname, "../src/shared/aiContent.js")],
  bundle: true, platform: "node", format: "cjs", outfile });
const ai = require(outfile);

// 接口地址规范化与校验
assert.strictEqual(ai.normalizeBaseURL(" https://api.deepseek.com/v1/ "), "https://api.deepseek.com/v1");
assert.strictEqual(ai.normalizeBaseURL("https://x.com/v1/chat/completions"), "https://x.com/v1");
assert.ok(ai.validateBaseURL(""));
assert.ok(ai.validateBaseURL("ftp://x.com"));
assert.ok(ai.validateBaseURL("not a url"));
assert.ok(ai.validateBaseURL("https://user:pass@x.com/v1"));
assert.strictEqual(ai.validateBaseURL("http://127.0.0.1:11434/v1"), "");

// 配置输入
const ok = ai.normalizeProviderInput({ name: " DS ", baseURL: "https://api.deepseek.com/v1/", model: "deepseek-chat", apiKey: " sk-abc ", preset: "deepseek" });
assert.strictEqual(ok.ok, true);
assert.deepStrictEqual(ok.value, { id: "", name: "DS", preset: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-abc" });
assert.strictEqual(ai.normalizeProviderInput({ name: "a", baseURL: "https://a.com", model: "m", preset: "evil" }).value.preset, "custom");
assert.strictEqual(ai.normalizeProviderInput({ name: "", baseURL: "https://a.com", model: "m" }).ok, false);
assert.strictEqual(ai.normalizeProviderInput({ name: "a", baseURL: "https://a.com", model: "" }).ok, false);
assert.strictEqual(ai.normalizeProviderInput({ name: "a", baseURL: "https://a.com", model: "m", apiKey: "sk a" }).ok, false);
assert.strictEqual(ai.normalizeProviderInput(null).ok, false);

// 打码：绝不回显完整 Key
const key = "sk-1234567890abcdefXYZW";
const masked = ai.maskApiKey(key);
assert.ok(masked.startsWith("sk-") && masked.endsWith("XYZW"));
assert.ok(!masked.includes("1234567890abcdef"));
assert.strictEqual(ai.maskApiKey("short"), "*****");
assert.strictEqual(ai.maskApiKey(""), "");
assert.strictEqual(ai.redactSecret(`Incorrect API key provided: ${key}`, key).includes(key), false);
// 短 Key（< 16 位）只露后 4 位
assert.strictEqual(ai.maskApiKey("abcdefghijkl"), "********ijkl");
// URL 编码、截断回显、Authorization / Bearer 都要去掉
const keyEnc = "sk-ab/cd+ef=1234567890";
assert.ok(!ai.redactSecret(`bad key ${encodeURIComponent(keyEnc)}`, keyEnc).includes(encodeURIComponent(keyEnc)));
const truncated = ai.redactSecret(`Incorrect API key provided: ${key.slice(0, 14)}****`, key);
assert.ok(!truncated.includes(key.slice(0, 10)), truncated);
const hdr = ai.redactSecret('headers: {"Authorization":"Bearer sk-other-secret-123"} and Bearer tok_abc', key);
assert.ok(!hdr.includes("sk-other-secret-123") && !hdr.includes("tok_abc"), hdr);
// 截断不切半个 emoji
assert.strictEqual(ai.parseTitle("😀".repeat(120)), "😀".repeat(100));
assert.strictEqual(ai.parseBody("a😀b", { maxLength: 2 }), "a😀");

// 提示词
const msgs = ai.buildGenerateMessages("title", { name: "周末去爬山", tags: ["#户外", "徒步"] });
assert.strictEqual(msgs.length, 2);
assert.strictEqual(msgs[0].role, "system");
assert.ok(msgs[1].content.includes("周末去爬山"));
assert.ok(msgs[1].content.includes("户外、徒步"));
assert.ok(ai.buildGenerateMessages("body", { contentType: "article", title: "x" })[1].content.includes("Markdown"));
assert.ok(ai.buildGenerateMessages("tags", { name: "x" })[1].content.includes("JSON"));
assert.throws(() => ai.buildGenerateMessages("evil", {}));
assert.strictEqual(ai.hasGenerateMaterial({}), false);
assert.strictEqual(ai.hasGenerateMaterial({ name: "  " }), false);
assert.strictEqual(ai.hasGenerateMaterial({ tags: ["a"] }), true);
// 超长素材会被截断
assert.ok(ai.buildGenerateMessages("title", { body: "字".repeat(10000) })[1].content.length < 3000);

// 输出解析：标题
assert.strictEqual(ai.parseTitle("标题：《周末爬山的快乐》"), "周末爬山的快乐");
assert.strictEqual(ai.parseTitle('"周末爬山⛰️太治愈了"\n其他说明'), "周末爬山⛰️太治愈了");
assert.strictEqual(ai.parseTitle("<think>先想想</think>\n1. 爬山日记"), "爬山日记");
assert.strictEqual(ai.parseTitle("# 爬山日记"), "爬山日记");
// 正文
assert.strictEqual(ai.parseBody("简介：第一段\n\n\n\n第二段"), "第一段\n\n第二段");
assert.strictEqual(ai.parseBody("a".repeat(3000)).length, 2000);
assert.strictEqual(ai.parseBody("```markdown\n## 小标题\n内容\n```", { maxLength: 0 }), "## 小标题\n内容");
// 标签
assert.deepStrictEqual(ai.parseTags('["户外","徒步","户外","#爬山"]'), ["户外", "徒步", "爬山"]);
assert.deepStrictEqual(ai.parseTags("```json\n[\"a\", \"b\"]\n```"), ["a", "b"]);
assert.deepStrictEqual(ai.parseTags("#户外 #徒步,周末、治愈"), ["户外", "徒步", "周末", "治愈"]);
assert.deepStrictEqual(ai.parseTags("1. 户外\n2. 徒步"), ["户外", "徒步"]);
assert.strictEqual(ai.parseTags(JSON.stringify(Array.from({ length: 20 }, (_, i) => `t${i}`))).length, 10);
assert.throws(() => ai.parseGeneration("tags", "[]"), /为空/);
assert.throws(() => ai.parseGeneration("title", "   "), /为空/);

// 响应体解析
assert.strictEqual(ai.extractCompletionText({ choices: [{ message: { content: "hi" } }] }), "hi");
assert.strictEqual(ai.extractCompletionText({ choices: [{ message: { content: [{ type: "text", text: "a" }, { text: "b" }] } }] }), "ab");
assert.strictEqual(ai.extractCompletionText({}), "");

console.log("test-ai-content: 全部断言通过");
