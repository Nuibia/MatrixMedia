"use strict";

import { AI_GENERATE_KINDS, hasGenerateMaterial, normalizeProviderInput } from "../../shared/aiContent.js";
import { generateContent, testConnection } from "./aiClient.js";

/**
 * AI 生成相关 IPC。只接受本应用自己的页面（file:// 或 dev 的 localhost）调用，
 * 账号登录窗里加载的外部平台页面一律拒绝，避免第三方页面读取配置或盗用额度。
 *
 * 注意：这里假设应用内只有本应用自己的界面会从 http(s)://localhost / 127.0.0.1 加载
 * （即开发模式的 dev server）。如果以后有登录窗或内嵌页加载本地第三方页面
 * （本地 mock、平台回调页等），需要把这里收窄到固定端口或改用其它校验方式。
 */
function isLocalAppSender(event) {
  try {
    const frame = new URL(String((event && event.senderFrame && event.senderFrame.url) || ""));
    return (
      (frame.protocol === "file:" && !frame.hostname) ||
      (["http:", "https:"].includes(frame.protocol) && ["localhost", "127.0.0.1"].includes(frame.hostname))
    );
  } catch (_) {
    return false;
  }
}

function wrap(handler) {
  return async (event, ...args) => {
    if (!isLocalAppSender(event)) return { ok: false, message: "不允许外部页面访问 AI 设置" };
    try {
      return { ok: true, ...(await handler(...args)) };
    } catch (error) {
      const res = { ok: false, message: (error && error.message) || "操作失败" };
      if (error && error.canceled) res.canceled = true;
      return res;
    }
  };
}

export function registerAiContentIpc(ipcMain, { store, generate = generateContent, test = testConnection }) {
  /** 进行中的生成请求：requestId -> AbortController，供 ai:cancel-generate 中止 */
  const pending = new Map();

  ipcMain.handle("ai:list-providers", wrap(async () => store.list()));

  ipcMain.handle(
    "ai:save-provider",
    wrap(async (input) => ({ provider: store.save(input || {}), ...store.list() }))
  );

  ipcMain.handle(
    "ai:delete-provider",
    wrap(async (id) => {
      store.remove(id);
      return store.list();
    })
  );

  ipcMain.handle(
    "ai:set-default-provider",
    wrap(async (id) => {
      store.setDefault(id);
      return store.list();
    })
  );

  /**
   * 测试连接。可传 { id } 测已保存配置，也可传未保存的表单内容；
   * 表单里 Key 留空且带 id 时，沿用已保存的 Key（明文 Key 不回传渲染进程）。
   */
  ipcMain.handle(
    "ai:test-provider",
    wrap(async (input) => {
      const payload = input || {};
      let provider;
      if (payload.id && !payload.baseURL) {
        provider = store.resolve(payload.id);
      } else {
        const normalized = normalizeProviderInput({ name: "测试", ...payload });
        if (!normalized.ok) throw new Error(normalized.message);
        const v = normalized.value;
        const apiKey = v.apiKey || (v.id ? store.resolve(v.id).apiKey : "");
        if (!apiKey) throw new Error("请填写 API Key");
        provider = { baseURL: v.baseURL, model: v.model, apiKey };
      }
      return test(provider);
    })
  );

  ipcMain.handle(
    "ai:generate",
    wrap(async (payload) => {
      const { kind, context, providerId, requestId } = payload || {};
      if (!AI_GENERATE_KINDS.includes(kind)) throw new Error("不支持的生成类型");
      if (!hasGenerateMaterial(context)) throw new Error("请先填写名称、标题或简介等素材，AI 才知道写什么");
      const provider = store.resolve(providerId);
      const key = requestId ? String(requestId) : "";
      const controller = new AbortController();
      if (key) {
        if (pending.has(key)) pending.get(key).abort();
        pending.set(key, controller);
      }
      try {
        const value = await generate(provider, kind, context || {}, {}, { signal: controller.signal });
        return { kind, value, providerId: provider.id, providerName: provider.name, model: provider.model };
      } finally {
        if (key && pending.get(key) === controller) pending.delete(key);
      }
    })
  );

  /** 中止进行中的生成（弹窗关闭或用户点「取消」时调用）；requestId 不存在时静默成功 */
  ipcMain.handle(
    "ai:cancel-generate",
    wrap(async (requestId) => {
      const key = String(requestId || "");
      const controller = pending.get(key);
      if (controller) {
        controller.abort();
        pending.delete(key);
      }
      return { canceled: !!controller };
    })
  );
}
