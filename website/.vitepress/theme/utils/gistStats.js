/**
 * 统计数据读取（GitHub Gist）
 *
 * 为什么不用 api.github.com：
 * 未认证的 GitHub REST API 限额是「每 IP 每小时 60 次」，官网访客共享出口 IP 时
 * 很容易触发 403 rate limit exceeded。改为读取 gist 的 raw 文件：
 *   https://gist.githubusercontent.com/<owner>/<gistId>/raw/<file>
 * raw 走 CDN（Cache-Control: max-age=300）、带 CORS，且不受 60/h 的 API 限额约束。
 *
 * 策略：raw 优先 → 失败回退 REST API → 再失败用本地过期缓存（stale）兜底。
 * 同一页面内并发请求做去重，localStorage 缓存 5 分钟。
 */

export const GIST_OWNER = "hanliang97";
export const GIST_ID = "9bd67e622baa655abf30cc151f0fcf5a";
export const OPENS_FILE = "events.json";
export const REQ_FILE = "requirements.json";
// 累计打开总数（{ total, updated }），由 Electron 端上报时 +1，
// 不受 events.json 只保留最近 5000 条的影响
export const META_FILE = "meta.json";

const RAW_BASE = `https://gist.githubusercontent.com/${GIST_OWNER}/${GIST_ID}/raw`;
const API_URL = `https://api.github.com/gists/${GIST_ID}`;
const CACHE_PREFIX = "mm_gist_file_";
const CACHE_TTL = 5 * 60 * 1000;

const inflight = new Map();

function cacheKey(file) {
  return `${CACHE_PREFIX}${file}`;
}

function readCache(file) {
  try {
    const raw = localStorage.getItem(cacheKey(file));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.t || obj.data == null) return null;
    return { data: obj.data, t: obj.t, fresh: Date.now() - obj.t <= CACHE_TTL };
  } catch (_) {
    return null;
  }
}

function writeCache(file, data) {
  try {
    localStorage.setItem(
      cacheKey(file),
      JSON.stringify({ t: Date.now(), data })
    );
  } catch (_) {}
}

function parseJson(text) {
  try {
    const v = JSON.parse(text || "null");
    return v === null ? null : v;
  } catch (_) {
    return null;
  }
}

async function fetchRaw(file) {
  const res = await fetch(`${RAW_BASE}/${file}`);
  if (!res.ok) throw new Error(`raw ${res.status}`);
  return parseJson(await res.text());
}

async function fetchApi(file) {
  const res = await fetch(API_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`api ${res.status}`);
  const data = await res.json();
  const f = data.files && data.files[file];
  return f && f.content ? parseJson(f.content) : null;
}

/**
 * 读取 gist 中的任意 JSON 文件（数组或对象均可）。
 * @param {string} file 文件名，如 events.json / meta.json
 * @param {{force?: boolean}} [opts] force=true 时跳过新鲜缓存强制刷新
 * @returns {Promise<{data: any, updatedAt: string, stale: boolean, error: string}>}
 *   data 为解析后的 JSON；文件不存在或解析失败时为 null（error 为空表示"文件确实不存在"）
 */
export async function loadGistFile(file, opts = {}) {
  const cached = readCache(file);
  if (!opts.force && cached && cached.fresh) {
    return {
      data: cached.data,
      updatedAt: new Date(cached.t).toISOString(),
      stale: false,
      error: "",
    };
  }

  const key = `${file}:${opts.force ? "force" : "auto"}`;
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    let lastErr = "";
    for (const fn of [fetchRaw, fetchApi]) {
      try {
        const data = await fn(file);
        if (data !== null) writeCache(file, data);
        return {
          data,
          updatedAt: new Date().toISOString(),
          stale: false,
          error: "",
        };
      } catch (e) {
        lastErr = (e && e.message) || String(e);
      }
    }
    // 全部失败：用过期缓存兜底，保证页面不空白
    if (cached) {
      return {
        data: cached.data,
        updatedAt: new Date(cached.t).toISOString(),
        stale: true,
        error: lastErr,
      };
    }
    return {
      data: null,
      updatedAt: null,
      stale: false,
      error: lastErr || "加载失败",
    };
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

/**
 * 读取 gist 中某个事件文件。
 * @param {string} file 文件名，如 events.json
 * @param {{force?: boolean}} [opts] force=true 时跳过新鲜缓存强制刷新
 * @returns {Promise<{events: any[], updatedAt: string, stale: boolean, error: string}>}
 */
export async function loadGistEvents(file, opts = {}) {
  const res = await loadGistFile(file, opts);
  const events = Array.isArray(res.data) ? res.data : [];
  return {
    events,
    updatedAt: res.updatedAt,
    stale: res.stale,
    error: res.error,
  };
}

/**
 * 读取累计打开总数（meta.json 的 total 字段）。
 * 老数据没有 meta.json 或字段缺失时返回 total: null，调用方回退用事件数组长度。
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{total: number|null, updatedAt: string, stale: boolean, error: string}>}
 */
export async function loadTotalOpens(opts = {}) {
  const res = await loadGistFile(META_FILE, opts);
  const d = res.data;
  const total =
    d && typeof d === "object" && !Array.isArray(d) && Number.isFinite(d.total)
      ? d.total
      : null;
  return {
    total,
    updatedAt: res.updatedAt,
    stale: res.stale,
    error: total === null ? res.error || "" : "",
  };
}

/**
 * 将完整数组写回 gist 的指定文件（需要 gist 权限的 token，通常是维护者）。
 * 注意：GitHub Gist 不支持协作，只有 gist 所有者的 token 才能 PATCH。
 * @param {string} file 文件名，如 requirements.json
 * @param {any[]} data 要写入的完整数组
 * @param {string} token GitHub Personal Access Token（gist 权限）
 */
export async function saveGistFile(file, data, token) {
  if (!token) throw new Error("缺少 GitHub Token");
  const res = await fetch(API_URL, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: { [file]: { content: JSON.stringify(data, null, 2) } },
    }),
  });
  if (!res.ok) {
    let msg = `GitHub API ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.message) msg = `${j.message}（${res.status}）`;
    } catch (_) {}
    throw new Error(msg);
  }
  // 写入成功后同步更新本地缓存
  writeCache(file, data);
  return res.json();
}
