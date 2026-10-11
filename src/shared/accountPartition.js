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
