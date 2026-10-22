"use strict";

/**
 * AI 生成标题 / 正文 / 标签的纯逻辑（主进程与测试共用，不依赖 Electron）。
 * 接口统一按 OpenAI 兼容的 /chat/completions 协议调用，
 * DeepSeek、通义千问（DashScope 兼容模式）、Kimi（Moonshot）、OpenAI 等均可直接使用。
 */

export const AI_GENERATE_KINDS = ["title", "body", "tags"];

/** 设置页「服务商」下拉的预设，选中后自动填入接口地址和推荐模型，用户仍可修改 */
export const AI_PROVIDER_PRESETS = [
  { key: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { key: "qwen", name: "通义千问", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { key: "moonshot", name: "Kimi（Moonshot）", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { key: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { key: "custom", name: "自定义（OpenAI 兼容）", baseURL: "", model: "" },
];

const MAX_NAME = 40;
const MAX_MODEL = 100;
const MAX_URL = 300;
const MAX_KEY = 500;
const MAX_CONTEXT_FIELD = 2000;

function str(v) {
  return v == null ? "" : String(v);
}

/** 接口地址规范化：去掉首尾空白、结尾的 / 和误填的 /chat/completions */
export function normalizeBaseURL(raw) {
  let url = str(raw).trim();
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/chat\/completions$/i, "");
  return url.replace(/\/+$/, "");
}

export function validateBaseURL(raw) {
  const url = normalizeBaseURL(raw);
  if (!url) return "请填写接口地址（Base URL）";
  if (url.length > MAX_URL) return "接口地址过长";
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return "接口地址格式不正确，应以 http:// 或 https:// 开头";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "接口地址只支持 http:// 或 https://";
  }
  if (parsed.username || parsed.password) return "接口地址里不要包含账号密码";
  return "";
}

/**
 * 校验并规范化设置页提交的服务商配置。
 * apiKey 允许为空（编辑时留空表示沿用已保存的 Key），由调用方决定是否必填。
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
export function normalizeProviderInput(input) {
  if (!input || typeof input !== "object") return { ok: false, message: "配置不能为空" };
  const name = str(input.name).trim();
  const model = str(input.model).trim();
  const apiKey = str(input.apiKey).trim();
  if (!name) return { ok: false, message: "请填写配置名称" };
  if (name.length > MAX_NAME) return { ok: false, message: `配置名称不能超过 ${MAX_NAME} 个字符` };
  const urlError = validateBaseURL(input.baseURL);
  if (urlError) return { ok: false, message: urlError };
  if (!model) return { ok: false, message: "请填写模型名称" };
  if (model.length > MAX_MODEL) return { ok: false, message: "模型名称过长" };
  if (apiKey.length > MAX_KEY) return { ok: false, message: "API Key 过长" };
  if (/\s/.test(apiKey)) return { ok: false, message: "API Key 不能包含空格或换行" };
  const preset = AI_PROVIDER_PRESETS.find((p) => p.key === input.preset);
  return {
    ok: true,
    value: {
      id: str(input.id).trim(),
      name,
      preset: preset ? preset.key : "custom",
      baseURL: normalizeBaseURL(input.baseURL),
      model,
      apiKey,
    },
  };
}

/**
 * 界面展示用：长 Key（>= 16 位）保留前 3 位与后 4 位；
 * 较短的 Key 只保留后 4 位，避免露出的字符占比过高；<= 8 位全部打码。
 */
export function maskApiKey(key) {
  const k = str(key).trim();
  if (!k) return "";
  if (k.length <= 8) return "*".repeat(k.length);
  if (k.length < 16) return `${"*".repeat(k.length - 4)}${k.slice(-4)}`;
  return `${k.slice(0, 3)}${"*".repeat(Math.min(12, k.length - 7))}${k.slice(-4)}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把任意字符串里出现的 Key 替换掉，防止接口错误信息回显 Key 后被打进日志或弹窗。
 * 除了原文，还覆盖 URL 编码后的 Key、截断回显（以 Key 前 8 位开头的片段）
 * 以及 `Bearer xxx` / `Authorization: xxx` 这类请求头内容。
 */
export function redactSecret(text, secret) {
  let s = str(text);
  s = s.replace(/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;}]+/gi, "$1***");
  s = s.replace(/\bbearer\s+[^\s"',;}]+/gi, "Bearer ***");
  const k = str(secret).trim();
  if (!k || k.length < 4) return s;
  const masked = maskApiKey(k);
  for (const variant of new Set([k, encodeURIComponent(k)])) {
    s = s.split(variant).join(masked);
  }
  if (k.length >= 12) {
    s = s.replace(new RegExp(`${escapeRegExp(k.slice(0, 8))}[^\\s"',;}]*`, "g"), masked);
  }
  return s;
}

function clip(v, max = MAX_CONTEXT_FIELD) {
  const s = str(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 整理生成上下文：视频 / 文章发布表单里已有的内容 */
export function normalizeGenerateContext(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const tags = Array.isArray(c.tags)
    ? c.tags.map((t) => str(t).replace(/^#+/, "").trim()).filter(Boolean).slice(0, 30)
    : [];
  return {
    contentType: c.contentType === "article" ? "article" : "video",
    name: clip(c.name, 200),
    title: clip(c.title, 200),
    body: clip(c.body),
    tags,
    hint: clip(c.hint, 500),
  };
}

export function hasGenerateMaterial(ctx) {
  const c = normalizeGenerateContext(ctx);
  return Boolean(c.name || c.title || c.body || c.tags.length || c.hint);
}

function describeContext(c) {
  const lines = [];
  if (c.name) lines.push(`${c.contentType === "article" ? "文件名" : "视频文件名"}：${c.name}`);
  if (c.title) lines.push(`当前标题：${c.title}`);
  if (c.body) lines.push(`${c.contentType === "article" ? "当前正文" : "当前简介"}：${c.body}`);
  if (c.tags.length) lines.push(`当前标签：${c.tags.join("、")}`);
  if (c.hint) lines.push(`补充要求：${c.hint}`);
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  "你是一名资深的中文自媒体运营，熟悉抖音、快手、视频号、小红书、B站、头条、百家号等平台的内容风格。" +
  "请根据用户提供的素材生成发布文案，内容真实、积极、合规，不使用夸大、违禁或诱导互动的词语。" +
  "只输出要求的内容本身，不要解释，不要加引号或前缀。";

/** 生成 /chat/completions 所需的 messages */
export function buildGenerateMessages(kind, ctx) {
  if (!AI_GENERATE_KINDS.includes(kind)) throw new Error(`不支持的生成类型：${kind}`);
  const c = normalizeGenerateContext(ctx);
  const isArticle = c.contentType === "article";
  let task;
  if (kind === "title") {
    task = isArticle
      ? "请为这篇文章写 1 个标题，不超过 30 个字，准确概括主题、有吸引力。只输出标题。"
      : "请为这条短视频写 1 个发布标题，不超过 30 个字，口语化、有吸引力，可以包含 1 个 emoji，不要带 # 话题。只输出标题。";
  } else if (kind === "body") {
    task = isArticle
      ? "请写一篇结构清晰的文章正文，使用 Markdown，包含小标题，800～1500 字。只输出正文。"
      : "请为这条短视频写一段简介/正文，100～300 字，分 2～4 小段，语气自然，可以适当使用 emoji，不要包含 # 话题标签。只输出简介。";
  } else {
    task =
      "请生成 5～8 个适合的话题标签，每个 2～10 个字，不带 # 号，不重复。" +
      '只输出 JSON 字符串数组，例如 ["美食","家常菜"]。';
  }
  const material = describeContext(c) || "（用户没有提供素材，请生成通用内容）";
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `素材：\n${material}\n\n任务：${task}` },
  ];
}

/** 去掉推理模型（DeepSeek-R1 / Qwen3 等）输出里的 <think> 段和 Markdown 代码围栏 */
function stripModelNoise(text) {
  return str(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();
}

function stripWrappingQuotes(s) {
  let t = s.trim();
  const pairs = [['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["《", "》"], ["「", "」"], ["【", "】"]];
  let changed = true;
  while (changed && t.length >= 2) {
    changed = false;
    for (const [a, b] of pairs) {
      if (t.startsWith(a) && t.endsWith(b) && t.length > a.length + b.length - 1) {
        t = t.slice(a.length, t.length - b.length).trim();
        changed = true;
      }
    }
  }
  return t;
}

/** 按字符（而非 UTF-16 码元）截断，避免把 emoji 等代理对切成半个 */
function sliceChars(s, n) {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join("") : s;
}

export function parseTitle(text) {
  const cleaned = stripModelNoise(text);
  const firstLine = cleaned.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  let t = firstLine.replace(/^(?:\d+[.、)]\s*|[-*•]\s*)/, "");
  t = t.replace(/^(?:标题|title)\s*[:：]\s*/i, "");
  t = stripWrappingQuotes(t).replace(/^#+\s*/, "").trim();
  return sliceChars(t, 100);
}

export function parseBody(text, { maxLength = 2000 } = {}) {
  let t = stripModelNoise(text).replace(/^(?:正文|简介|内容)\s*[:：]\s*/, "");
  t = t.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return maxLength > 0 ? sliceChars(t, maxLength) : t;
}

export function parseTags(text, { max = 10 } = {}) {
  const cleaned = stripModelNoise(text);
  let list = null;
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) list = arr.map((x) => str(x));
    } catch (_) {
      list = null;
    }
  }
  if (!list) {
    list = cleaned
      .replace(/^(?:标签|话题|tags)\s*[:：]\s*/i, "")
      .replace(/#/g, " #")
      .split(/[\s,，、;；\n]+/);
  }
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const v = stripWrappingQuotes(str(raw).replace(/^\d+[.、)]\s*/, "").trim())
      .replace(/^#+/, "")
      .trim();
    if (!v || v.length > 20 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** 按类型解析模型输出；结果为空时抛错，交给界面提示 */
export function parseGeneration(kind, text, options = {}) {
  let value;
  if (kind === "title") value = parseTitle(text);
  else if (kind === "body") value = parseBody(text, options);
  else if (kind === "tags") value = parseTags(text, options);
  else throw new Error(`不支持的生成类型：${kind}`);
  if (!value || (Array.isArray(value) && value.length === 0)) {
    throw new Error("AI 返回内容为空，请重试或更换模型");
  }
  return value;
}

/** 从 /chat/completions 响应体中取出文本 */
export function extractCompletionText(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : choice && choice.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("");
  }
  return "";
}
