"use strict";

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { maskApiKey, normalizeProviderInput } from "../../shared/aiContent.js";

/**
 * AI 服务商配置与 API Key 的本地存储（仅主进程使用）。
 *
 * - 文件：<userData>/ai-settings.json，权限 0600，先写临时文件再 rename，避免写一半损坏
 * - Key 优先用 Electron safeStorage 加密（Windows DPAPI / macOS 钥匙串 / Linux libsecret），
 *   系统不支持加密时才退回 base64 存储，并在设置页提示用户
 * - 对渲染进程只返回打码后的 Key（maskedKey），明文 Key 只在主进程发请求时解密使用
 */

const FILE_VERSION = 1;

function emptyData() {
  return { version: FILE_VERSION, defaultId: "", providers: [] };
}

export function createAiKeyStore({ filePath, safeStorage = null, fileSystem = fs, now = () => Date.now() } = {}) {
  if (!filePath) throw new Error("缺少 AI 配置文件路径");

  function canEncrypt() {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch (_) {
      return false;
    }
  }

  function encodeKey(plain) {
    if (!plain) return null;
    if (canEncrypt()) {
      return { enc: "safeStorage", data: safeStorage.encryptString(plain).toString("base64") };
    }
    return { enc: "plain", data: Buffer.from(plain, "utf8").toString("base64") };
  }

  function decodeKey(stored) {
    if (!stored || !stored.data) return "";
    const buf = Buffer.from(String(stored.data), "base64");
    if (stored.enc === "safeStorage") {
      if (!canEncrypt()) throw new Error("系统加密存储不可用，无法读取已保存的 API Key，请重新填写");
      return safeStorage.decryptString(buf);
    }
    return buf.toString("utf8");
  }

  function read() {
    let raw;
    try {
      raw = fileSystem.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return emptyData();
      throw error;
    }
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.providers)) return emptyData();
      return { version: FILE_VERSION, defaultId: String(data.defaultId || ""), providers: data.providers };
    } catch (_) {
      // 文件损坏时不覆盖原文件，交给用户处理
      throw new Error("AI 配置文件已损坏：" + filePath);
    }
  }

  function write(data) {
    fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fileSystem.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fileSystem.renameSync(tmp, filePath);
    try {
      fileSystem.chmodSync(filePath, 0o600);
    } catch (_) {
      /* Windows 上 chmod 无效果，忽略 */
    }
  }

  function toPublic(p, defaultId) {
    let masked = "";
    let keyError = "";
    try {
      masked = maskApiKey(decodeKey(p.key));
    } catch (error) {
      keyError = error.message;
    }
    return {
      id: p.id,
      name: p.name,
      preset: p.preset || "custom",
      baseURL: p.baseURL,
      model: p.model,
      hasKey: Boolean(p.key && p.key.data),
      maskedKey: masked,
      keyError,
      isDefault: p.id === defaultId,
      updatedAt: p.updatedAt || 0,
    };
  }

  function ensureDefault(data) {
    if (!data.providers.some((p) => p.id === data.defaultId)) {
      data.defaultId = data.providers.length ? data.providers[0].id : "";
    }
    return data;
  }

  return {
    isSecure: canEncrypt,

    list() {
      const data = ensureDefault(read());
      return {
        providers: data.providers.map((p) => toPublic(p, data.defaultId)),
        defaultId: data.defaultId,
        secureStorage: canEncrypt(),
      };
    },

    /** 新增或编辑；编辑时 apiKey 留空表示沿用原 Key */
    save(input) {
      const normalized = normalizeProviderInput(input);
      if (!normalized.ok) throw new Error(normalized.message);
      const v = normalized.value;
      const data = read();
      const idx = v.id ? data.providers.findIndex((p) => p.id === v.id) : -1;
      if (v.id && idx < 0) throw new Error("要编辑的配置不存在，可能已被删除");
      const existing = idx >= 0 ? data.providers[idx] : null;
      if (!v.apiKey && !(existing && existing.key && existing.key.data)) {
        throw new Error("请填写 API Key");
      }
      const record = {
        id: existing ? existing.id : crypto.randomUUID(),
        name: v.name,
        preset: v.preset,
        baseURL: v.baseURL,
        model: v.model,
        key: v.apiKey ? encodeKey(v.apiKey) : existing.key,
        createdAt: existing ? existing.createdAt || now() : now(),
        updatedAt: now(),
      };
      if (idx >= 0) data.providers.splice(idx, 1, record);
      else data.providers.push(record);
      if (input.setDefault || !data.defaultId) data.defaultId = record.id;
      write(ensureDefault(data));
      return toPublic(record, data.defaultId);
    },

    remove(id) {
      const data = read();
      const before = data.providers.length;
      data.providers = data.providers.filter((p) => p.id !== String(id || ""));
      if (data.providers.length === before) throw new Error("配置不存在，可能已被删除");
      write(ensureDefault(data));
      return true;
    },

    setDefault(id) {
      const data = read();
      if (!data.providers.some((p) => p.id === String(id || ""))) throw new Error("配置不存在");
      data.defaultId = String(id);
      write(data);
      return true;
    },

    /** 主进程内部使用：返回含明文 Key 的配置；id 为空时取默认配置 */
    resolve(id) {
      const data = ensureDefault(read());
      const targetId = String(id || data.defaultId || "");
      const p = data.providers.find((x) => x.id === targetId);
      if (!p) {
        throw new Error(
          data.providers.length ? "所选 AI 配置不存在" : "还没有配置 AI 接口，请先到「项目详情 → AI 设置」添加 API Key"
        );
      }
      const apiKey = decodeKey(p.key);
      if (!apiKey) throw new Error(`配置「${p.name}」缺少 API Key`);
      return { id: p.id, name: p.name, baseURL: p.baseURL, model: p.model, apiKey };
    },
  };
}
