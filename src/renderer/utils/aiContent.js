import { ipcRenderer } from "electron";

/** 渲染进程调用 AI 相关 IPC 的薄封装：统一把 { ok:false, message } 转成异常 */
async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.ok) throw new Error((res && res.message) || "操作失败");
  return res;
}

export const listAiProviders = () => invoke("ai:list-providers");
export const saveAiProvider = (input) => invoke("ai:save-provider", input);
export const deleteAiProvider = (id) => invoke("ai:delete-provider", id);
export const setDefaultAiProvider = (id) => invoke("ai:set-default-provider", id);
export const testAiProvider = (input) => invoke("ai:test-provider", input);
export const generateAiContent = (kind, context) => invoke("ai:generate", { kind, context });
