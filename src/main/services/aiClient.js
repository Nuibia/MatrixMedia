"use strict";

import axios from "axios";
import {
  buildGenerateMessages,
  extractCompletionText,
  parseGeneration,
  redactSecret,
} from "../../shared/aiContent.js";

/**
 * OpenAI 兼容 /chat/completions 客户端（仅主进程调用，Key 不经过渲染进程）。
 * 所有错误信息都会先去掉 Key 再返回，日志里也不打印请求头。
 */

export const AI_REQUEST_TIMEOUT_MS = 60 * 1000;
export const AI_TEST_TIMEOUT_MS = 20 * 1000;

function describeHttpError(status, body) {
  const remote =
    (body && body.error && (body.error.message || body.error.code)) ||
    (body && body.message) ||
    "";
  const suffix = remote ? `：${String(remote).slice(0, 200)}` : "";
  if (status === 401 || status === 403) return `API Key 无效或没有权限（${status}）${suffix}`;
  if (status === 404) return `接口地址或模型名称不存在（404），请检查 Base URL 和模型${suffix}`;
  if (status === 429) return `请求过于频繁或额度不足（429）${suffix}`;
  if (status === 402) return `账户余额不足（402）${suffix}`;
  if (status >= 500) return `AI 服务暂时不可用（${status}）${suffix}`;
  return `AI 接口返回错误（${status}）${suffix}`;
}

export const AI_CANCELED_MESSAGE = "已取消生成";

export function isCanceledError(error) {
  return !!(error && (error.code === "ERR_CANCELED" || error.name === "CanceledError" || error.__CANCEL__ || error.canceled));
}

export function toFriendlyError(error, apiKey) {
  let message;
  if (isCanceledError(error)) {
    const canceled = new Error(AI_CANCELED_MESSAGE);
    canceled.canceled = true;
    return canceled;
  }
  if (error && error.response) {
    message = describeHttpError(error.response.status, error.response.data);
  } else if (error && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || /timeout/i.test(error.message || ""))) {
    message = "请求超时，请检查网络或稍后重试";
  } else if (error && ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"].includes(error.code)) {
    message = `无法连接到接口地址（${error.code}），请检查 Base URL 和网络`;
  } else {
    message = (error && error.message) || "AI 请求失败";
  }
  return new Error(redactSecret(message, apiKey));
}

export async function chatCompletion(
  { baseURL, apiKey, model, messages, temperature = 0.8, maxTokens, timeoutMs = AI_REQUEST_TIMEOUT_MS, signal },
  { http = axios } = {}
) {
  const body = { model, messages, temperature, stream: false };
  if (maxTokens) body.max_tokens = maxTokens;
  let res;
  try {
    if (signal && signal.aborted) throw Object.assign(new Error("canceled"), { code: "ERR_CANCELED" });
    res = await http.request({
      signal,
      method: "POST",
      url: `${baseURL}/chat/completions`,
      data: body,
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // 只认 2xx，其余进 catch 统一转友好提示
      validateStatus: (s) => s >= 200 && s < 300,
    });
  } catch (error) {
    throw toFriendlyError(error, apiKey);
  }
  const text = extractCompletionText(res && res.data);
  if (!text) throw new Error("AI 接口返回格式不正确（缺少 choices[0].message.content），请确认接口兼容 OpenAI 协议");
  return text;
}

/** 生成标题 / 正文 / 标签 */
export async function generateContent(provider, kind, context, deps = {}, { signal } = {}) {
  const messages = buildGenerateMessages(kind, context);
  const isArticleBody = kind === "body" && context && context.contentType === "article";
  const text = await chatCompletion(
    {
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      model: provider.model,
      messages,
      maxTokens: isArticleBody ? 3000 : 800,
      signal,
    },
    deps
  );
  return parseGeneration(kind, text, { maxLength: isArticleBody ? 20000 : 2000 });
}

/** 测试连接：发一条极短的请求，确认地址、Key、模型三者都可用 */
export async function testConnection(provider, deps = {}) {
  const started = Date.now();
  await chatCompletion(
    {
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [{ role: "user", content: "回复“好”" }],
      temperature: 0,
      maxTokens: 5,
      timeoutMs: AI_TEST_TIMEOUT_MS,
    },
    deps
  );
  return { latencyMs: Date.now() - started };
}
