"use strict";

/**
 * 账号 session partition 统一拼装规则。
 *
 * 背景：账号名（phone 字段）允许带 "-" 备注后缀（如 "主号组-皇汉科技AI"）。
 * 登录态统一存放在「账号名 "-" 前缀 + 平台名」的 persist 分区里：
 *
 *   buildAccountPartition("主号组-皇汉科技AI", "视频号")
 *   // => "persist:主号组视频号"
 *
 * 所有需要读写登录态（cookie / localStorage）的入口——登录窗口、发布窗口、
 * 状态轮询、数据统计采集——都必须使用本函数拼装，禁止各自手写字符串拼接。
 * 历史上采集侧漏掉 split("-")[0]，导致带 "-" 的账号登录态写在 A 分区、
 * 采集却读 B 分区，被判未登录（典型现象：采集窗口被重定向到扫码登录页）。
 */

/**
 * 取账号名的登录态主键（"-" 前缀部分）。
 * @param {string} phone 账号名（可带 "-" 备注后缀）
 * @returns {string}
 */
export function accountSessionKey(phone) {
  return String(phone || "").split("-")[0];
}

/**
 * 拼出账号在某平台的 session partition。
 * @param {string} phone 账号名（可带 "-" 备注后缀）
 * @param {string} pt 平台名（如 抖音 / 视频号）
 * @returns {string} 如 "persist:13800138000抖音"
 */
export function buildAccountPartition(phone, pt) {
  return "persist:" + accountSessionKey(phone) + pt;
}

/**
 * 把任意历史形态的 partition 规整为标准形态 persist:<账号名"-"前缀><平台>。
 *
 * 背景：历史上 sph / 抖音登录入口对传入 partition 简单 split("-")[0]，把平台后缀
 * 一起截掉（persist:测试-2视频号 → persist:测试）：登录写进 A 分区，发布/查询按
 * 标准规则读 persist:测试视频号，表现为「登录成功但账号一直显示未登录」。
 * 直接删掉裁剪又会让带 "-" 的旧输入打到空分区，因此这里做"归一"而不是"不裁剪"：
 *
 *   1. 平台后缀保留 / 补齐：先摘掉结尾的 <平台>，取账号段 "-" 前缀，再拼回 <平台>；
 *   2. persist: 前缀补齐：漏写时 cookie 不落盘，登录「成功」但进程退出即丢。
 *
 *   canonicalAccountPartition("persist:测试-2视频号", "视频号") => "persist:测试视频号"
 *   canonicalAccountPartition("persist:测试", "视频号")         => "persist:测试视频号"（历史截断值补回后缀）
 *   canonicalAccountPartition("测试视频号", "视频号")            => "persist:测试视频号"（补 persist:）
 *   canonicalAccountPartition("persist:测试视频号", "视频号")    => "persist:测试视频号"（标准值原样返回）
 *
 * 标准入口（GUI / parseLoginArgs / 采集）产出的 partition 均已是标准形态，此函数为 no-op。
 *
 * @param {string} partition 任意形态的 partition
 * @param {string} pt 平台名（如 视频号 / 抖音），用于识别并保留平台后缀
 * @returns {string}
 */
export function canonicalAccountPartition(partition, pt) {
  const raw = String(partition || "");
  if (!raw) return raw;
  const suffix = String(pt || "");
  let head = raw;
  if (suffix && raw.endsWith(suffix)) {
    head = raw.slice(0, raw.length - suffix.length);
  }
  let account = head.split("-")[0];
  if (!account.startsWith("persist:")) {
    account = "persist:" + account.replace(/^persist:?/, "");
  }
  return account + suffix;
}
