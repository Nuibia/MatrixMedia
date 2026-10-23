"use strict";

/**
 * 验证快手描述填写逻辑（#34：标题/简介为空静默发布）：
 * 1. composeKsFillText：标题拼到描述最前，重复/缺失情形不重复拼接
 * 2. fillKsDescription：keyboard.type 正常落地 → 直接成功，不走兜底
 * 3. keyboard.type 不落地 → execCommand('insertText') 兜底成功
 * 4. 全部失败 → 尝试 maxAttempts 次后抛错中止（不再静默发空作品）
 * 5. 编辑器缺失 → waitForSelector 抛错
 */

const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });

const outfile = path.join(outDir, "ksDescription.cjs");
buildSync({
  entryPoints: [path.join(root, "src/main/services/upLoad/ks.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  external: ["electron"],
});

const { composeKsFillText, fillKsDescription, KS_DESCRIPTION_SELECTOR } = require(outfile);

// ---------- 1. composeKsFillText ----------
assert.strictEqual(
  composeKsFillText({ title: "标题A", description: "简介B" }),
  "标题A\n简介B"
);
assert.strictEqual(composeKsFillText({ title: "标题A", description: "" }), "标题A");
assert.strictEqual(composeKsFillText({ title: "", description: "简介B" }), "简介B");
assert.strictEqual(composeKsFillText({ title: "", description: "" }), "");
// 描述已以标题开头：不重复拼
assert.strictEqual(
  composeKsFillText({ title: "标题A", description: "标题A 简介B" }),
  "标题A 简介B"
);
assert.strictEqual(composeKsFillText(), "");

// ---------- 假 page：用 Function 构造器在注入的假 DOM 上执行 evaluate 函数 ----------
function createFakePage({ typeLands = true, execCommandLands = true, editorPresent = true } = {}) {
  const editor = {
    text: "",
    focused: false,
    get innerText() {
      return this.text;
    },
    focus() {
      this.focused = true;
    },
  };
  const calls = { typeCount: 0, execCommands: [] };
  const fakeWindow = {
    getSelection: () => ({
      selectAllChildren: () => {},
      removeAllRanges: () => {},
      addRange: () => {},
    }),
  };
  const fakeDocument = {
    querySelector: (sel) =>
      editorPresent && sel === KS_DESCRIPTION_SELECTOR ? editor : null,
    createRange: () => ({}),
    execCommand: (cmd, _a, text) => {
      calls.execCommands.push(cmd);
      if (cmd === "delete") {
        editor.text = "";
        return true;
      }
      if (cmd === "insertText" && execCommandLands) {
        editor.text = String(text || "");
        return true;
      }
      return false;
    },
  };
  const page = {
    keyboard: {
      type: async (t) => {
        calls.typeCount += 1;
        if (typeLands) editor.text += t;
      },
      press: async () => {},
    },
    async click(sel) {
      if (sel === KS_DESCRIPTION_SELECTOR && !editorPresent) throw new Error("no such element");
      calls.clickCount = (calls.clickCount || 0) + 1;
    },
    async waitForSelector(sel) {
      if (editorPresent && sel === KS_DESCRIPTION_SELECTOR) return editor;
      throw new Error(`waiting failed: timeout`);
    },
    async evaluate(fn, arg) {
      const f = new Function(
        "document",
        "window",
        "arg",
        `return (${fn.toString()})(arg);`
      );
      return f(fakeDocument, fakeWindow, arg);
    },
  };
  return { page, editor, calls };
}

(async () => {
  // 2. 正常落地：type 写入成功，无需 insertText 兜底
  {
    const { page, editor, calls } = createFakePage({ typeLands: true });
    const r = await fillKsDescription(page, "标题A\n简介B");
    assert.strictEqual(r, true);
    assert.strictEqual(editor.text, "标题A\n简介B");
    assert.ok(!calls.execCommands.includes("insertText"), "正常落地不应走 insertText 兜底");
  }

  // 3. type 不落地 → execCommand 兜底成功，且兜底前先清空避免重复
  {
    const { page, editor, calls } = createFakePage({ typeLands: false });
    const r = await fillKsDescription(page, "简介B #标签");
    assert.strictEqual(r, true);
    assert.strictEqual(editor.text, "简介B #标签");
    assert.ok(calls.execCommands.includes("insertText"), "应调用 insertText 兜底");
  }

  // 4. 全部失败 → maxAttempts 次后抛错，错误信息可读
  {
    const { page } = createFakePage({ typeLands: false, execCommandLands: false });
    await assert.rejects(
      () => fillKsDescription(page, "简介B", { maxAttempts: 2 }),
      (e) => /快手描述填写失败/.test(e.message) && /已中止/.test(e.message)
    );
  }

  // 5. 编辑器不存在 → waitForSelector 抛错
  {
    const { page } = createFakePage({ editorPresent: false });
    await assert.rejects(() => fillKsDescription(page, "简介B"), /timeout/);
  }

  // 6. fillText 为空：不写内容也不报错（用户只发了视频没填文案）
  {
    const { page } = createFakePage({ typeLands: false, execCommandLands: false });
    const r = await fillKsDescription(page, "");
    assert.strictEqual(r, true);
  }

  console.log("ks-description: 全部断言通过");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
