"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { buildSync } = require("esbuild");
const root = path.join(__dirname, "..");
const cache = path.join(root, "test/.cache");
fs.mkdirSync(cache, { recursive: true });

// 纯 ESM 共享模块：Node 24 原生 require(ESM) 可直接加载
const {
  accountSessionKey,
  buildAccountPartition,
  canonicalAccountPartition,
} = require("../src/shared/accountPartition.js");

// 依赖 electron 的入口模块：按 test-sph-cookie-session 的惯例 esbuild 打包成 CJS
// （electron 标记 external，运行时 require("electron") 返回路径字符串，不影响纯函数）
function bundle(rel, outfile) {
  buildSync({
    entryPoints: [path.join(root, rel)],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile,
  });
  return require(outfile);
}
const sphOut = path.join(cache, "account-partition-sph-test.cjs");
const douyinOut = path.join(cache, "account-partition-douyin-test.cjs");
const { normalizeSphPartition } = bundle(
  "src/main/services/cliLogin/sphSessionUtil.js",
  sphOut
);
const { normalizeDouyinPartition } = bundle(
  "src/main/services/cliLogin/douyinSessionUtil.js",
  douyinOut
);

/* 1) accountSessionKey：取账号名 "-" 前缀 */
assert.strictEqual(accountSessionKey("主号组-皇汉科技AI"), "主号组");
assert.strictEqual(accountSessionKey("测试"), "测试");
assert.strictEqual(accountSessionKey(null), "");

/* 2) buildAccountPartition：标准拼装 */
assert.strictEqual(buildAccountPartition("主号组-皇汉科技AI", "视频号"), "persist:主号组视频号");
assert.strictEqual(buildAccountPartition("13800138000", "抖音"), "persist:13800138000抖音");

/* 3) canonicalAccountPartition：标准值原样返回（no-op） */
for (const [p, pt] of [
  ["persist:测试视频号", "视频号"],
  ["persist:主号组视频号", "视频号"],
  ["persist:13800138000抖音", "抖音"],
]) {
  assert.strictEqual(canonicalAccountPartition(p, pt), p, `${p} 应原样返回`);
}

/* 4) 带 "-" 备注的账号名：去备注但保留平台后缀（旧 split("-")[0] 会把后缀一起截掉） */
assert.strictEqual(canonicalAccountPartition("persist:测试-2视频号", "视频号"), "persist:测试视频号");
assert.strictEqual(canonicalAccountPartition("persist:主号组-皇汉科技AI视频号", "视频号"), "persist:主号组视频号");
assert.strictEqual(canonicalAccountPartition("persist:138-备注抖音", "抖音"), "persist:138抖音");

/* 5) 历史截断值（平台后缀被旧版吃掉）：补回后缀 */
assert.strictEqual(canonicalAccountPartition("persist:测试", "视频号"), "persist:测试视频号");
assert.strictEqual(canonicalAccountPartition("persist:主号组", "视频号"), "persist:主号组视频号");

/* 6) 漏 persist: 前缀（cookie 不落盘）：补齐 */
assert.strictEqual(canonicalAccountPartition("测试视频号", "视频号"), "persist:测试视频号");
assert.strictEqual(canonicalAccountPartition("persist测试视频号", "视频号"), "persist:测试视频号");

/* 7) 账号名本身以平台名结尾：摘掉的是结尾的平台后缀，账号段原样拼回（恒等） */
assert.strictEqual(canonicalAccountPartition("persist:美食视频号", "视频号"), "persist:美食视频号");
assert.strictEqual(canonicalAccountPartition("persist:视频号主号视频号", "视频号"), "persist:视频号主号视频号");

/* 8) 空值：返回空串（保持旧行为，由调用方校验） */
assert.strictEqual(canonicalAccountPartition("", "视频号"), "");
assert.strictEqual(canonicalAccountPartition(null, "视频号"), "");

/* 9) sph / douyin 登录入口的 normalize 复用同一套规则 */
assert.strictEqual(normalizeSphPartition("persist:测试视频号"), "persist:测试视频号");
assert.strictEqual(normalizeSphPartition("persist:测试-2视频号"), "persist:测试视频号");
assert.strictEqual(normalizeSphPartition("persist:测试"), "persist:测试视频号");
assert.strictEqual(normalizeSphPartition("测试视频号"), "persist:测试视频号");
assert.strictEqual(normalizeDouyinPartition("persist:测试-2抖音"), "persist:测试抖音");
assert.strictEqual(normalizeDouyinPartition("persist:13800138000抖音"), "persist:13800138000抖音");

/* 10) 回归：发布入口不再简单 split("-")[0] 截断 partition */
const uploadSrc = fs.readFileSync(
  path.join(root, "src/main/services/puppeteerFile.js"),
  "utf8"
);
assert.ok(
  !/data\.partition\s*=\s*data\.partition\.split\("-"\)\[0\]/.test(uploadSrc),
  "puppeteerFile 不应再对 partition 做 split(\"-\")[0]（平台后缀会被截掉，发布落到空分区）"
);
assert.ok(
  /canonicalAccountPartition/.test(uploadSrc),
  "puppeteerFile 应使用 canonicalAccountPartition 规整 partition"
);

/* 11) 回归：代理配置不应把 partition 截断后再 fromPartition */
const proxySrc = fs.readFileSync(
  path.join(root, "src/main/services/proxyConfig.js"),
  "utf8"
);
assert.ok(
  !/fromPartition\([^)]*\.split\("-"\)/.test(proxySrc),
  "proxyConfig 不应把 partition 裁剪后建 session（代理与登录/发布会落到两个会话）"
);

console.log("test-account-partition passed");
