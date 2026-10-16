"use strict";

import { session } from "electron";
import { canonicalAccountPartition } from "../../../shared/accountPartition.js";

export const SPH_ORIGIN = "https://channels.weixin.qq.com";

/** 视频号 partition 的标准平台后缀 */
export const SPH_PARTITION_SUFFIX = "视频号";

/**
 * 把任意历史形态的视频号 partition 规整为标准 persist:<账号"-"前缀>视频号。
 *
 * 旧实现简单 split("-")[0] 会把平台后缀一起截掉（persist:测试-2视频号 →
 * persist:测试），登录写进错误分区、发布/查询却按标准规则读 persist:测试视频号，
 * 表现为「登录成功但账号一直未登录」。现在统一走 canonicalAccountPartition：
 *
 *   persist:测试-2视频号 → persist:测试视频号（保留平台后缀，去账号 "-" 备注）
 *   persist:测试        → persist:测试视频号（历史截断值补回平台后缀）
 *   测试视频号           → persist:测试视频号（补 persist:，cookie 才会落盘）
 *   persist:测试视频号   → 原样返回（标准值）
 */
export function normalizeSphPartition(partition) {
  return canonicalAccountPartition(partition, SPH_PARTITION_SUFFIX);
}

/**
 * 获取当前 sessionid 值（可能为 null）。
 */
export async function getSphSessionId(partition) {
  const part = normalizeSphPartition(partition);
  const ses = session.fromPartition(part);
  const cookies = await ses.cookies.get({ url: SPH_ORIGIN });
  const c = cookies.find(c => c.name === "sessionid" && c.value);
  return c ? c.value : null;
}

/**
 * 判断视频号是否已登录：检查 sessionid Cookie。
 */
export async function hasSphSession(partition) {
  return !!(await getSphSessionId(partition));
}
