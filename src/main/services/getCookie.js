import { app, ipcMain, session } from "electron";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { evaluateLoginCookies } from "../../shared/loginState.js";
import { probeSphSession } from "./sphAuthProbe.js";

/**
 * 登录态读取（GUI 徽标 / accountLoginFlag 的数据源）。
 *
 * 关键背景：GUI 进程内 session.fromPartition 的 cookie jar 是首次用到该分区时
 * 加载的内存副本，Chromium 不会感知其它进程写盘的变更。CLI 登录（独立进程，
 * 如 dam-mm-helper 驱动的 `cli login`）成功后 cookie 落在磁盘上，GUI 仍然读
 * 自己的旧副本 → 「CLI 登录成功、GUI 一直显示未登录」并反复弹登录窗。
 *
 * 因此这里优先起一个 `cli accounts --json --out <tmp>` 子进程（cli 模式跳过
 * 单实例锁）从磁盘读真实登录态；子进程失败时回退到进程内判定（旧行为）。
 * 可用 MATRIX_GUI_FRESH_LOGIN_STATE=0 关闭子进程路径（调试用）。
 */

const FRESH_STATE_TIMEOUT_MS = 90 * 1000;

/** 同一批 getCookie 只起一个子进程；结束后自动失效，下一批重新读盘 */
let freshRowsPromise = null;

function freshLoginStateDisabled() {
  return process.env.MATRIX_GUI_FRESH_LOGIN_STATE === "0";
}

function spawnAccountsCliJson(outFile) {
  return new Promise((resolve, reject) => {
    // 开发模式 process.defaultApp=true：electron . cli ...，argv[1] 是应用入口
    const devEntry = process.defaultApp ? [path.resolve(process.argv[1])] : [];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = spawn(
        process.execPath,
        [...devEntry, "cli", "accounts", "--json", "--out", outFile],
        { env, windowsHide: true }
      );
    } catch (e) {
      reject(e);
      return;
    }
    let errText = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
      reject(new Error("cli accounts 子进程超时"));
    }, FRESH_STATE_TIMEOUT_MS);
    // stdout 只有 [startup] 等日志行（JSON 走 --out 文件），持续消费防止管道写满阻塞
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      errText += chunk;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `cli accounts 退出码 ${code}${
              errText ? "：" + String(errText).slice(0, 200) : ""
            }`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(fs.readFileSync(outFile, "utf-8")));
      } catch (e) {
        reject(new Error(`cli accounts 输出解析失败: ${e && e.message}`));
      }
    });
  });
}

async function fetchFreshLoginRows() {
  if (!freshRowsPromise) {
    const outFile = path.join(
      app.getPath("temp"),
      `matrixmedia-accounts-${process.pid}-${Date.now()}.json`
    );
    freshRowsPromise = spawnAccountsCliJson(outFile)
      .catch((e) => {
        console.warn("[getCookie] 子进程读取登录态失败，回退进程内判定:", e && e.message);
        return null;
      })
      .finally(() => {
        freshRowsPromise = null;
        try {
          fs.rmSync(outFile, { force: true });
        } catch (_) {
          /* ignore */
        }
      });
  }
  return freshRowsPromise;
}

/** 按旧回复结构组装 payload（result 是给 renderer 存 document.cookie 的标记串） */
function buildReply(args, { loggedIn, reason, expireMs }) {
  let result = "";
  let loginExpiresAtMs = null;
  if (loggedIn) {
    // 命中登录 cookie 但拿不到 expires（会话 cookie，如掘金 / 小红书）时给兜底有效期：
    // 语义为「假定 90 天内有效」，与旧实现一致
    const expMs = expireMs || Date.now() + 90 * 24 * 60 * 60 * 1000;
    result = `${args.name}=true; expires=${new Date(expMs).toUTCString()}; path=/`;
    loginExpiresAtMs = expMs;
  }
  return {
    taskId: args.taskId,
    success: true,
    result,
    flagName: args.name,
    loginExpiresAtMs,
    pt: args.pt,
    reason: reason || "",
    cookies: [],
  };
}

export default function () {
  ipcMain.on("getCookie", async (event, args) => {
    // 子进程等待期间 renderer 可能已销毁（页面切换），reply 失败不应抛错
    const safeReply = (payload) => {
      try {
        event.reply("getCookie-done", payload);
      } catch (_) {
        /* ignore */
      }
    };

    // 1) 子进程读磁盘真实登录态：CLI 登录写盘后 GUI 内存副本是旧的
    if (!freshLoginStateDisabled()) {
      try {
        const rows = await fetchFreshLoginRows();
        if (Array.isArray(rows)) {
          const row = rows.find(
            (r) => r && String(r.partition) === String(args.partition)
          );
          if (row) {
            safeReply(
              buildReply(args, {
                loggedIn: Boolean(row.loggedIn),
                reason: row.reason,
                expireMs: row.expireAt,
              })
            );
            return;
          }
          // 匹配不到行（账号刚删除 / partition 拼法不一致）→ 回退进程内判定
        }
      } catch (_) {
        /* 已 warn，回退进程内判定 */
      }
    }

    // 2) 回退：进程内 session 判定（旧行为）
    try {
      const ses = session.fromPartition(args.partition);
      const cookies = await ses.cookies.get({ url: args.url });
      let result = "";
      let loginExpiresAtMs = null;

      // 统一登录判定：除了 cookie 存在，还要排除「已过期但仍留在 jar 里」的凭据，
      // 否则 cookie 被服务端提前失效后界面仍显示已登录，用户发布时才失败。
      const verdict = evaluateLoginCookies(args.pt, cookies);

      // 视频号额外做一次真实探测：sessionid 不按时间过期，服务端可随时作废，
      // 此时 cookie 仍在、expires 也没到，只看 cookie 必然误判为已登录。
      if (verdict.loggedIn && args.pt === "视频号") {
        const probed = await probeSphSession(args.partition);
        if (probed.ok && probed.loggedIn === false) {
          console.log(
            `[getCookie] 视频号真实探测判定未登录: ${probed.reason}`
          );
          verdict.loggedIn = false;
          verdict.reason = probed.reason || "会话已失效";
        } else if (!probed.ok) {
          // 网络异常 / 未知错误码：保留 cookie 判定结果，避免断网误判
          console.log(
            `[getCookie] 视频号真实探测未得出结论，沿用 cookie 判定: ${probed.reason}`
          );
        }
      }

      if (verdict.loggedIn) {
        const expMs =
          verdict.expireMs || Date.now() + 90 * 24 * 60 * 60 * 1000;
        result = `${args.name}=true; expires=${new Date(expMs).toUTCString()}; path=/`;
        loginExpiresAtMs = expMs;
      } else if (verdict.reason && verdict.reason !== "未知平台") {
        console.log(
          `[getCookie] ${args.pt} 未登录: ${verdict.reason}${
            verdict.expireMs
              ? ` (过期于 ${new Date(verdict.expireMs).toLocaleString()})`
              : ""
          }`
        );
      }

      safeReply({
        taskId: args.taskId,
        success: true,
        result: result,
        flagName: args.name,
        loginExpiresAtMs,
        pt: args.pt,
        reason: verdict.reason,
        cookies,
      });
    } catch (err) {
      console.error("获取 cookie 失败:", err);
      safeReply({
        taskId: args.taskId,
        success: false,
        error: err.message,
        flagName: args.name,
      });
    }
  });
}
