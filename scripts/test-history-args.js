"use strict";

/**
 * 验证 `cli history` 参数解析的输入契约（#41）：
 * 1. 带值选项位于参数末尾（缺值）时必须报参数错误，而不是静默通过
 * 2. 带值选项的值不能是下一个选项（如 --phone --json）
 * 3. --days/--limit 严格正整数：拒绝 "30garbage"、"2.5"、"-3"、"0" 等被 parseInt 截断的输入
 * 4. 合法输入与别名解析行为保持不变
 */

const assert = require("assert");
const { parseHistoryArgs } = require("../src/main/cli/parseHistoryArgs.js");

// 1. 带值选项缺值（位于末尾）→ 一律报错，之前会返回 ok: true
for (const flag of [
  "--phone",
  "--platform",
  "-p",
  "--status",
  "-s",
  "--since",
  "--until",
  "--days",
  "-d",
  "--limit",
  "-n",
]) {
  const r = parseHistoryArgs([flag]);
  assert.strictEqual(r.ok, false, `${flag} 缺值应报错`);
  assert.ok(/需要一个值|需为正整数/.test(r.error), `${flag} 错误信息应明确：${r.error}`);
}

// 2. 值不能是下一个选项
for (const argv of [
  ["--phone", "--json"],
  ["-p", "-s"],
  ["--since", "--until"],
  ["--phone", "-p", "dy"],
]) {
  const r = parseHistoryArgs(argv);
  assert.strictEqual(r.ok, false, `${argv.join(" ")} 应报错`);
}

// 3. 数值选项严格校验
for (const argv of [
  ["--days", "30garbage"],
  ["--days", "2.5"],
  ["--days", "-3"],
  ["--days", "0"],
  ["--days", ""],
  ["--limit", "2.5"],
  ["--limit", "1e3"],
  ["-n", "abc"],
  ["-d", " 7 "], // 空白可容忍，但下面单独断言合法情形
]) {
  const r = parseHistoryArgs(argv);
  const raw = String(argv[1]).trim();
  if (/^\d+$/.test(raw) && parseInt(raw, 10) >= 1) {
    assert.strictEqual(r.ok, true, `${argv.join(" ")} 应通过`);
  } else {
    assert.strictEqual(r.ok, false, `${argv.join(" ")} 应报错`);
    assert.ok(
      /需为正整数|需要一个值/.test(r.error),
      `${argv.join(" ")} 错误信息：${r.error}`
    );
  }
}

// 4. 合法输入不受影响
assert.deepStrictEqual(parseHistoryArgs(["-p", "dy", "-d", "30", "-s", "failed", "-n", "10"]), {
  ok: true,
  value: {
    platform: "抖音",
    phone: null,
    status: "failed",
    days: 30,
    limit: 10,
    since: null,
    until: null,
    json: false,
  },
});
assert.strictEqual(parseHistoryArgs(["--phone", "138****0001", "--json"]).value.phone, "138****0001");
assert.strictEqual(parseHistoryArgs(["--since", "2026-04-01", "--until", "2026-04-18"]).ok, true);
assert.strictEqual(parseHistoryArgs(["--since", "2026-04-01"]).ok, true);
assert.strictEqual(parseHistoryArgs(["--json"]).ok, true);
assert.strictEqual(parseHistoryArgs(["-h"]).value.help, true);
// 非法日期仍被拦截
assert.strictEqual(parseHistoryArgs(["--since", "20260401"]).ok, false);
// 未知参数仍被拦截
assert.strictEqual(parseHistoryArgs(["--oops"]).ok, false);

console.log("history-args: ok");
