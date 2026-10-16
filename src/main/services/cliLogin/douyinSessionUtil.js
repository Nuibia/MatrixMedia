"use strict";

import { session } from "electron";
import { canonicalAccountPartition } from "../../../shared/accountPartition.js";

export const CREATOR_ORIGIN = "https://creator.douyin.com";

/**
 * 把任意历史形态的抖音 partition 规整为标准 persist:<账号"-"前缀>抖音。
 * 旧实现 split("-")[0] 会把平台后缀一起截掉（persist:测试-2抖音 → persist:测试），
 * 登录与发布/查询落到两个分区；规则详见 shared/accountPartition.js。
 */
export function normalizeDouyinPartition(partition) {
  return canonicalAccountPartition(partition, "抖音");
}

export async function hasDouyinSession(partition) {
  const part = normalizeDouyinPartition(partition);
  const ses = session.fromPartition(part);
  const cookies = await ses.cookies.get({ url: CREATOR_ORIGIN });
  return cookies.some(c => c.name === "passport_assist_user" && c.value);
}
