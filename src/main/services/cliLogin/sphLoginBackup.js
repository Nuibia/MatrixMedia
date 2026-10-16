"use strict";

import fs from "fs";
import path from "path";

/**
 * 视频号 CLI 登录的磁盘会话备份。
 *
 * 背景：`--force` 登录为了强制出二维码，会先清空分区的 sph Cookie；原实现只把
 * 快照放在进程内存里，恢复逻辑挂在 finish()（成功 / 超时 / 关窗）上。进程一旦被
 * 外部杀掉（helper 取消、taskkill、崩溃、断电），恢复不会执行，唯一可用会话被
 * 永久清空 —— 账号从「已登录」直接变「未登录 / 无登录 cookie」。
 *
 * 方案：清 Cookie 前先把快照原子写入 <userData>/sph-login-backup/<partition>.json；
 * 登录成功、或失败时内存恢复完成后删除；进程被杀则文件残留，由下次视频号登录
 * （sphCliLogin）或账号状态查询（runAccountsCli，仅当分区完全无 sessionid 时）
 * 自动恢复。本模块只做纯文件读写与判定，不依赖 electron，便于测试。
 */

export const SPH_LOGIN_BACKUP_VERSION = 1;

function backupFileBase(dir, partition) {
  return path.join(dir, encodeURIComponent(String(partition || "")) + ".json");
}

/**
 * 原子写入会话备份（tmp + rename），返回文件路径。
 * @param {string} dir 备份目录
 * @param {string} partition 标准 partition（如 persist:测试视频号）
 * @param {Array<object>} cookies 快照的 sph Cookie 列表
 */
export function saveSphLoginBackup(dir, partition, cookies) {
  const file = backupFileBase(dir, partition);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    version: SPH_LOGIN_BACKUP_VERSION,
    partition: String(partition || ""),
    savedAt: Date.now(),
    cookies: Array.isArray(cookies) ? cookies : [],
  };
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload), "utf-8");
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 读取备份；不存在 / 损坏 / partition 不匹配时返回 null。
 * @returns {{version:number, partition:string, savedAt:number, cookies:Array<object>} | null}
 */
export function loadSphLoginBackup(dir, partition) {
  let raw;
  try {
    raw = fs.readFileSync(backupFileBase(dir, partition), "utf-8");
  } catch (_) {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || data.partition !== String(partition || "")) return null;
    if (!Array.isArray(data.cookies)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/** 删除备份（幂等，同时清掉可能残留的 tmp 文件） */
export function clearSphLoginBackup(dir, partition) {
  const base = backupFileBase(dir, partition);
  try {
    fs.rmSync(base, { force: true });
  } catch (_) {
    /* ignore */
  }
  try {
    const prefix = path.basename(base) + ".tmp";
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix)) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * 自动恢复上次被中断的 --force 登录会话。
 *
 * 判定规则（只做无破坏性的动作）：
 *   - 无备份：不动；
 *   - 当前分区无 sessionid：典型的「--force 清空后进程被杀」→ 恢复备份；
 *   - 当前 sessionid 鉴权仍有效：上次登录其实已在被杀前完成 → 仅清理备份；
 *   - 当前 sessionid 已失效（仅登录入口，onlyIfNoSession=false）：恢复备份；
 *   - 鉴权探测结果未知 / onlyIfNoSession 且当前有 sessionid：不动，保留备份。
 *
 * @param {object} options
 * @param {string} options.dir 备份目录
 * @param {string} options.partition 标准 partition
 * @param {() => Promise<string|null>} options.getSessionId 读取当前 sessionid
 * @param {() => Promise<{ok:boolean, loggedIn?:boolean}>} [options.probe] 服务端鉴权探测
 * @param {(cookies: Array<object>) => Promise<void>} options.restoreCookies 把备份写回分区
 * @param {boolean} [options.onlyIfNoSession] 保守模式：当前已有 sessionid 时一律不动
 *   （供账号状态查询使用，避免读状态的路径覆盖现存会话）
 * @returns {Promise<string|null>} 动作描述（用于日志）；null 表示未动作
 */
export async function recoverSphLoginBackup({
  dir,
  partition,
  getSessionId,
  probe,
  restoreCookies,
  onlyIfNoSession = false,
}) {
  const backup = loadSphLoginBackup(dir, partition);
  if (!backup) return null;

  const sessionId = await getSessionId();
  if (!sessionId) {
    await restoreCookies(backup.cookies);
    clearSphLoginBackup(dir, partition);
    return "检测到上次视频号强制登录被中断，已恢复登录前的会话";
  }

  if (onlyIfNoSession) return null;

  let verdict = null;
  try {
    verdict = await probe();
  } catch (_) {
    verdict = null;
  }
  if (verdict && verdict.ok && verdict.loggedIn === true) {
    clearSphLoginBackup(dir, partition);
    return "上次视频号强制登录已在退出前完成，清理会话备份";
  }
  if (!verdict || !verdict.ok) return null;

  await restoreCookies(backup.cookies);
  clearSphLoginBackup(dir, partition);
  return "当前视频号会话已失效，已恢复上次强制登录前的会话";
}
