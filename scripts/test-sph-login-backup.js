"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildSync } = require("esbuild");
const root = path.join(__dirname, "..");
const cache = path.join(root, "test/.cache");
fs.mkdirSync(cache, { recursive: true });
const outfile = path.join(cache, "sph-login-backup-test.cjs");
buildSync({
  entryPoints: [path.join(root, "src/main/services/cliLogin/sphLoginBackup.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
});
const {
  saveSphLoginBackup,
  loadSphLoginBackup,
  clearSphLoginBackup,
  recoverSphLoginBackup,
} = require(outfile);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sph-backup-test-"));
const partition = "persist:测试视频号";
const cookies = [
  { name: "sessionid", value: "fixture-old", domain: "channels.weixin.qq.com", path: "/", hostOnly: true, secure: true },
  { name: "other", value: "x", domain: ".weixin.qq.com", path: "/" },
];

function recorder({ sessionId, probeResult, restoreError } = {}) {
  const calls = { probe: 0, restore: 0 };
  return {
    calls,
    getSessionId: async () => sessionId,
    probe: async () => {
      calls.probe++;
      return probeResult;
    },
    restoreCookies: async (list) => {
      calls.restore++;
      if (restoreError) throw restoreError;
      calls.restoredCookies = list;
    },
  };
}

(async () => {
  /* 1) save / load / clear 基本读写 */
  saveSphLoginBackup(dir, partition, cookies);
  const loaded = loadSphLoginBackup(dir, partition);
  assert.ok(loaded, "备份应可读回");
  assert.strictEqual(loaded.partition, partition);
  assert.deepStrictEqual(loaded.cookies, cookies);

  /* 2) partition 不匹配 / 文件损坏 → null */
  assert.strictEqual(loadSphLoginBackup(dir, "persist:其它视频号"), null);
  const backupFile = path.join(dir, encodeURIComponent(partition) + ".json");
  fs.writeFileSync(backupFile, "{not-json", "utf-8");
  assert.strictEqual(loadSphLoginBackup(dir, partition), null);

  /* 3) clear 幂等，且清掉残留 tmp */
  saveSphLoginBackup(dir, partition, cookies);
  clearSphLoginBackup(dir, partition);
  clearSphLoginBackup(dir, partition);
  assert.strictEqual(loadSphLoginBackup(dir, partition), null);

  /* 4) 无备份：recover 不做任何动作 */
  {
    const r = recorder({ sessionId: "sid" });
    assert.strictEqual(
      await recoverSphLoginBackup({ dir, partition, ...r }),
      null
    );
    assert.strictEqual(r.calls.probe, 0);
    assert.strictEqual(r.calls.restore, 0);
  }

  /* 5) 备份 + 当前无 sessionid（典型 --force 清空后被杀）→ 恢复并清理 */
  {
    saveSphLoginBackup(dir, partition, cookies);
    const r = recorder({ sessionId: null });
    const message = await recoverSphLoginBackup({ dir, partition, ...r });
    assert.ok(/已恢复/.test(message), message);
    assert.strictEqual(r.calls.restore, 1);
    assert.deepStrictEqual(r.calls.restoredCookies, cookies);
    assert.strictEqual(loadSphLoginBackup(dir, partition), null, "恢复后备份应清理");
  }

  /* 6) 备份 + 当前会话仍有效 → 视为上次登录已完成，仅清理备份，不覆盖 */
  {
    saveSphLoginBackup(dir, partition, cookies);
    const r = recorder({ sessionId: "new-sid", probeResult: { ok: true, loggedIn: true } });
    const message = await recoverSphLoginBackup({ dir, partition, ...r });
    assert.ok(/清理/.test(message), message);
    assert.strictEqual(r.calls.restore, 0, "会话有效时不得覆盖");
    assert.strictEqual(loadSphLoginBackup(dir, partition), null);
  }

  /* 7) 备份 + 当前会话已失效（登录入口模式）→ 恢复备份 */
  {
    saveSphLoginBackup(dir, partition, cookies);
    const r = recorder({
      sessionId: "half-session",
      probeResult: { ok: true, loggedIn: false, reason: "视频号登录凭据无效，请重新登录" },
    });
    const message = await recoverSphLoginBackup({ dir, partition, ...r });
    assert.ok(/已恢复/.test(message), message);
    assert.strictEqual(r.calls.restore, 1);
    assert.strictEqual(loadSphLoginBackup(dir, partition), null);
  }

  /* 8) 鉴权探测未知（网络异常）→ 不动，保留备份交给后续流程判断 */
  {
    saveSphLoginBackup(dir, partition, cookies);
    const r = recorder({ sessionId: "sid", probeResult: { ok: false, reason: "探测超时" } });
    assert.strictEqual(await recoverSphLoginBackup({ dir, partition, ...r }), null);
    assert.strictEqual(r.calls.restore, 0);
    assert.ok(loadSphLoginBackup(dir, partition), "未知结果时备份应保留");
  }

  /* 9) onlyIfNoSession（账号状态查询）：当前有 sessionid 时一律不动，且不发起探测 */
  {
    saveSphLoginBackup(dir, partition, cookies);
    const r = recorder({ sessionId: "sid", probeResult: { ok: true, loggedIn: false } });
    assert.strictEqual(
      await recoverSphLoginBackup({ dir, partition, ...r, onlyIfNoSession: true }),
      null
    );
    assert.strictEqual(r.calls.probe, 0, "保守模式不应发起网络探测");
    assert.strictEqual(r.calls.restore, 0);
    assert.ok(loadSphLoginBackup(dir, partition), "保守模式备份应保留");
  }

  /* 10) onlyIfNoSession + 无 sessionid → 仍会恢复 */
  {
    saveSphLoginBackup(dir, partition, cookies);
    const r = recorder({ sessionId: null });
    const message = await recoverSphLoginBackup({
      dir,
      partition,
      ...r,
      onlyIfNoSession: true,
    });
    assert.ok(/已恢复/.test(message), message);
    assert.strictEqual(loadSphLoginBackup(dir, partition), null);
  }

  /* 11) 恢复写入失败 → 异常上抛，备份保留（下次还能恢复） */
  {
    saveSphLoginBackup(dir, partition, cookies);
    const r = recorder({ sessionId: null, restoreError: new Error("fixture-restore-fail") });
    await assert.rejects(
      recoverSphLoginBackup({ dir, partition, ...r }),
      /fixture-restore-fail/
    );
    assert.ok(loadSphLoginBackup(dir, partition), "恢复失败时备份应保留");
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("test-sph-login-backup passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
