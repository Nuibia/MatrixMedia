import path from "path";
import fs from "fs";
import {
  readPageUrl,
  replyPublishFailure,
  replyPublishOutcome,
} from "./publishOutcome.js";
import {
  isCreativeStatementNone,
  resolveKsCreativeStatementLabel,
} from "../../../shared/creativeStatement.js";
import { buildPlatformVideoText } from "../../../shared/videoMetadata.js";
import {
  WAIT_SELECTOR_APPEAR_MS,
  WAIT_UPLOAD_PROCESSING_MS,
  pollPageUntil,
} from "./uploadTimeouts.js";

export const KS_DESCRIPTION_SELECTOR = "#work-description-edit";

function collapseText(t) {
  return String(t || "").replace(/\s+/g, "");
}

/** 读取快手描述编辑器当前内容（页面已销毁时返回空串） */
function readKsDescription(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? String(el.innerText || el.textContent || "") : "";
  }, KS_DESCRIPTION_SELECTOR);
}

/**
 * 快手没有单独的标题输入框，作品标题取自描述文案；用户填了标题时把它拼在描述最前面
 * （描述已以标题开头时不重复拼接）。#34
 */
export function composeKsFillText({ title, description } = {}) {
  const t = String(title || "").trim();
  const d = String(description || "").trim();
  if (!t) return d;
  if (!d) return t;
  if (collapseText(d).startsWith(collapseText(t))) return d;
  return `${t}\n${d}`;
}

/**
 * 往快手描述编辑器（#work-description-edit，contenteditable 自定义组件）写文案。
 *
 * keyboard.type 对这类组件在隐藏窗口/遮罩残留时经常不落地（#34：静默发出空标题作品），
 * 所以每次写入后必须回读校验：
 *   1. 主路径 click 聚焦 + keyboard.type；
 *   2. 回读未落地 → 清空后用 document.execCommand('insertText') 兜底（同小红书适配器）；
 *   3. 重试 maxAttempts 次（默认 3），仍失败则抛错中止发布，
 *      宁可走失败上报/自动重试，也不能把空标题/空简介的作品发出去。
 */
export async function fillKsDescription(page, fillText, { maxAttempts = 3 } = {}) {
  await page.waitForSelector(KS_DESCRIPTION_SELECTOR, {
    timeout: WAIT_SELECTOR_APPEAR_MS,
  });
  const expected = collapseText(fillText);
  let landed = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 聚焦 + 清空旧内容：puppeteer click 定位 caret，evaluate focus 双保险，再全选删除
    try {
      await page.click(KS_DESCRIPTION_SELECTOR, { clickCount: 3 });
    } catch (_) {
      // click 偶发失败不致命，下面 evaluate focus 兜底
    }
    await page.evaluate((sel) => {
      var el = document.querySelector(sel);
      if (!el) return;
      el.focus();
      var s = window.getSelection && window.getSelection();
      if (s && s.selectAllChildren) {
        try {
          s.selectAllChildren(el);
        } catch (_) {}
      }
      if (document.execCommand) document.execCommand("delete");
    }, KS_DESCRIPTION_SELECTOR);
    if (fillText) {
      await page.keyboard.type(fillText, { delay: 50 });
    }

    landed = collapseText(await readKsDescription(page));
    if (!expected || (landed && landed.includes(expected))) {
      if (attempt > 1) console.log(`[ks] 描述已在第 ${attempt} 次尝试写入`);
      return true;
    }
    console.warn(
      `[ks] 第 ${attempt} 次填写描述未落地（回读到 ${landed.length} 字），尝试 execCommand 兜底`
    );

    // 兜底：全选删除后 insertText，对富文本组件比键盘事件可靠
    await page.evaluate(
      (payload) => {
        var el = document.querySelector(payload.sel);
        if (!el) return;
        el.focus();
        if (document.createRange && window.getSelection) {
          try {
            var r = document.createRange();
            r.selectNodeContents(el);
            var s = window.getSelection();
            s.removeAllRanges();
            s.addRange(r);
          } catch (_) {}
        }
        if (document.execCommand) {
          document.execCommand("delete");
          document.execCommand("insertText", false, payload.text);
        }
      },
      { sel: KS_DESCRIPTION_SELECTOR, text: fillText }
    );

    landed = collapseText(await readKsDescription(page));
    if (!expected || (landed && landed.includes(expected))) {
      console.log(`[ks] 描述已通过 execCommand 兜底写入（第 ${attempt} 次尝试）`);
      return true;
    }
  }

  throw new Error(
    `快手描述填写失败：尝试 ${maxAttempts} 次后文案仍未写入编辑器（编辑器当前 ${landed.length} 字），为避免发出空标题/空简介的作品已中止本次发布`
  );
}

/**
 * 快手自定义封面（探针实证配方）：
 * 封面设置区渲染晚于预览 video（要等「封面设置/智能推荐封面」文案出现）；
 * 点 [class*="_cover-full-editor"] → ant-modal（封面截取/上传封面两 tab）→
 * 「上传封面」tab → modal 内隐藏 file input（_cropper-upload-upload）注入 →
 * 裁剪比例选 3:4（推荐）→ 确认 → 校验 _default-cover 槽位 img src 变化（blob 帧图→新封面）。
 */
async function uploadKsCustomCover(page, coverPath) {
  if (!fs.existsSync(coverPath)) {
    throw new Error(`封面文件不存在: ${coverPath}`);
  }

  await page
    .waitForFunction(
      () => {
        const t = document.body.innerText || "";
        return t.includes("封面设置") || t.includes("智能推荐封面");
      },
      { timeout: 60000 }
    )
    .catch(() => {
      throw new Error("等待快手封面设置区出现超时（60s）");
    });

  const slotSrcBefore = await page.evaluate(() => {
    const img = document.querySelector('[class*="_default-cover"] img');
    return img ? img.src : "";
  });

  const opened = await page.evaluate(() => {
    const el =
      document.querySelector('[class*="_cover-full-editor"]') ||
      document.querySelector('[class*="_default-cover"]');
    if (!el) return false;
    el.click();
    return true;
  });
  if (!opened) throw new Error("未找到快手「封面设置」入口");
  await page.waitForSelector(".ant-modal", { visible: true, timeout: 15000 });
  await page.waitForTimeout(1200);

  const tabbed = await page.evaluate(() => {
    const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
    const m = document.querySelector(".ant-modal");
    if (!m) return false;
    for (const el of m.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || el.children.length > 2) continue;
      if (norm(el.textContent) === "上传封面") {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!tabbed) throw new Error("快手封面弹窗内未找到「上传封面」tab");
  await page.waitForTimeout(1200);

  const inputHandle = await page.evaluateHandle(() => {
    const m = document.querySelector(".ant-modal");
    if (!m) return null;
    return (
      m.querySelector('input[type="file"]') ||
      m.querySelector('[class*="cropper-upload"] input') ||
      null
    );
  });
  const inputEl = inputHandle.asElement();
  if (!inputEl) throw new Error("快手封面弹窗内未找到图片 file input");
  await inputEl.uploadFile(path.resolve(coverPath));
  console.log("[ks] 封面文件已注入上传区:", coverPath);

  // 等裁剪器加载出图片（canvas 或 cropper/preview img）
  await page
    .waitForFunction(
      () => {
        const m = document.querySelector(".ant-modal");
        if (!m) return false;
        return !!(
          m.querySelector("canvas") ||
          m.querySelector('[class*="cropper"] img') ||
          m.querySelector('[class*="preview"] img')
        );
      },
      { timeout: 20000 }
    )
    .catch(() => console.warn("[ks] 未观察到裁剪器加载信号，继续尝试"));
  await page.waitForTimeout(1500);

  // 裁剪比例选 3:4（推荐）——3:4 原图（如 1080x1440）选中后无裁损
  const ratio = await page.evaluate(() => {
    const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
    const m = document.querySelector(".ant-modal");
    if (!m) return { ok: false, reason: "no-modal" };
    const cands = [];
    for (const el of m.querySelectorAll('[class*="ratio"] *')) {
      const t = norm(el.textContent);
      if ((t === "3:4" || t === "3:4推荐") && el.children.length <= 2) {
        cands.push(el);
      }
    }
    if (!cands.length) return { ok: false, reason: "no-3:4-option" };
    cands.sort((a, b) => a.children.length - b.children.length);
    cands[0].click();
    return { ok: true, count: cands.length };
  });
  console.log("[ks] 裁剪比例 3:4 选择:", JSON.stringify(ratio));
  // 与其它步骤口径一致：找不到 3:4 选项即失败抛错中止，不容忍平台按默认比例裁剪
  if (!ratio.ok) {
    throw new Error(`快手封面裁剪未选到 3:4 比例（${ratio.reason}）`);
  }
  await page.waitForTimeout(1000);

  const confirmed = await page.evaluate(() => {
    const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
    const m = document.querySelector(".ant-modal");
    if (!m) return false;
    for (const b of m.querySelectorAll("button,[role='button']")) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && !b.disabled && norm(b.textContent) === "确认") {
        b.click();
        return true;
      }
    }
    return false;
  });
  if (!confirmed) throw new Error("快手封面弹窗内未找到「确认」按钮");
  await page.waitForTimeout(3500);

  // 校验：封面槽位 img src 相对设置前变化（原为 blob: 视频帧图）；快手 CDN 域名为强信号
  const after = await page.evaluate(() => {
    const img = document.querySelector('[class*="_default-cover"] img');
    return img ? img.src : "";
  });
  const changed = !!after && after !== slotSrcBefore;
  if (!changed) {
    throw new Error(
      `快手封面设置后槽位图片未变化（src=${(after || "").slice(0, 120)}）`
    );
  }
  const cdn = /ssrcdn|kwaicdn|kwcdn|kscdn|yximgs/.test(after);
  console.log(
    `[ks] 自定义封面已设置并校验通过（src变化=true, CDN=${cdn}）: ${after.slice(0, 120)}`
  );
}

async function selectKsCreativeStatement(page, data) {
  const value = data.data && data.data.creativeStatement;
  console.log("[ks] creativeStatement 值 =", value);
  // 快手目前只支持 AI 生成 / 演绎情节 两个选项；其它值（含「无标注」）无对应选项，跳过即可。
  if (isCreativeStatementNone(value)) {
    console.log("[ks] 无标注，快手保持默认不选");
    return;
  }
  const label = resolveKsCreativeStatementLabel(value);
  // 当前快手「作者声明」下拉支持的四个文案；未匹配则跳过。
  const SUPPORTED = new Set([
    "内容为AI生成",
    "演绎情节，仅供娱乐",
    "个人观点，仅供参考",
    "素材来源于网络",
  ]);
  if (!SUPPORTED.has(label)) {
    console.warn(`[ks] 当前声明值 "${value}" 在快手没有对应选项，跳过`);
    return;
  }
  console.log("[ks] 准备选择声明:", label);

  // 1. 通过 label 文本"作者声明 / 作品声明 / 声明"定位下拉触发器；返回它的 id 给后续用 page.click。
  //    ant-design Select 监听的是 mousedown，必须用真实鼠标事件（page.click 自带）才能打开下拉。
  const triggerInfo = await page.evaluate(() => {
    var norm = function (t) {
      return String(t || "")
        .replace(/\s+/g, "")
        .trim();
    };
    var LABEL_KEYWORDS = ["作者声明", "作品声明", "创作声明", "声明"];
    var formItems = document.querySelectorAll(
      '[class*="edit-form-item"], [class*="form-item"]'
    );
    for (var i = 0; i < formItems.length; i++) {
      var item = formItems[i];
      var label = item.querySelector("label");
      var labelText = norm(label && label.textContent);
      var matched = false;
      for (var k = 0; k < LABEL_KEYWORDS.length; k++) {
        if (labelText.indexOf(LABEL_KEYWORDS[k]) !== -1) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      var sel = item.querySelector(".ant-select");
      var selector = sel && sel.querySelector(".ant-select-selector");
      if (!selector) continue;
      var id = "__ks_statement_trigger_" + Date.now() + "__";
      selector.setAttribute("id", id);
      return { ok: true, matchedLabel: labelText, id: id };
    }
    var labels = [];
    for (var j = 0; j < formItems.length; j++) {
      var l = formItems[j].querySelector("label");
      labels.push(norm(l && l.textContent));
    }
    return { ok: false, labels: labels };
  });

  if (!triggerInfo || !triggerInfo.ok) {
    console.warn(
      "未找到快手声明下拉触发器，跳过。当前页 form-item labels:",
      JSON.stringify(triggerInfo && triggerInfo.labels)
    );
    return;
  }
  console.log("[ks] 找到下拉触发器, label =", triggerInfo.matchedLabel);

  // 用 puppeteer 真鼠标事件打开 dropdown（ant-design 走 mousedown）
  try {
    await page.click(`#${triggerInfo.id}`, { delay: 80 });
    console.log("[ks] 已 page.click 打开下拉");
  } catch (e) {
    console.warn("[ks] page.click 失败，尝试 DOM 派发事件:", e?.message || e);
    await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    }, triggerInfo.id);
    console.log("[ks] 已 DOM 派发 mousedown/mouseup/click");
  }

  // 2. 等下拉项可见（ant-design 用 rc-virtual-list，可见项是 .ant-select-item.ant-select-item-option，
  //    其 title 属性 = 文案；隐藏的 [role="option"] 不可点击，要忽略）
  try {
    await page.waitForFunction(
      (text) => {
        var opts = document.querySelectorAll(
          ".ant-select-dropdown .ant-select-item.ant-select-item-option"
        );
        for (var i = 0; i < opts.length; i++) {
          var o = opts[i];
          var t =
            o.getAttribute("title") ||
            (o.querySelector(".ant-select-item-option-content") || {})
              .textContent ||
            "";
          if (String(t).trim() === text) return true;
        }
        return false;
      },
      { timeout: 15000 },
      label
    );
  } catch (e) {
    console.warn("快手声明下拉项未出现:", e?.message || e);
    return;
  }

  // 3. 点选目标选项：点 .ant-select-item-option 本身（ant-design 在它上面绑定 mousedown）
  const pickResult = await page.evaluate((text) => {
    var opts = document.querySelectorAll(
      ".ant-select-dropdown .ant-select-item.ant-select-item-option"
    );
    var titles = [];
    for (var ti = 0; ti < opts.length; ti++) {
      titles.push(opts[ti].getAttribute("title") || "");
    }
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var t =
        o.getAttribute("title") ||
        (o.querySelector(".ant-select-item-option-content") || {})
          .textContent ||
        "";
      if (String(t).trim() !== text) continue;
      var rect = o.getBoundingClientRect();
      var opts2 = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      // ant-design Option 走 mousedown 选中：派发完整事件序列保证生效
      o.dispatchEvent(new MouseEvent("mousedown", opts2));
      o.dispatchEvent(new MouseEvent("mouseup", opts2));
      o.dispatchEvent(new MouseEvent("click", opts2));
      var inner = o.querySelector(".ant-select-item-option-content");
      if (inner) {
        inner.dispatchEvent(new MouseEvent("click", opts2));
      }
      return { ok: true, titles: titles };
    }
    return { ok: false, titles: titles };
  }, label);

  if (!pickResult || !pickResult.ok) {
    console.warn(
      `未找到快手声明选项: ${label}；下拉里实际 title 列表 = ${JSON.stringify(
        pickResult && pickResult.titles
      )}`
    );
    return;
  }
  await page.waitForTimeout(300);
  console.log("[ks] 已选择声明:", label);
}

export default async function (page, data, window, event) {
  const isDraftMode =
    data.publishMode === "draft" || data.publishToDraft === true;
  const submitText = isDraftMode ? "取消" : "发布";

  console.log(data);
  let descFillText = "";
  try {
    let sel = '#joyride-wrapper input[type="file"]';
    await page.waitForSelector(sel, { timeout: WAIT_SELECTOR_APPEAR_MS });
    const uploadInputs = await page.$(sel);
    await uploadInputs.uploadFile(path.resolve(data.filePath));
  } catch (err) {
    console.error("文件上传失败:", err);
  }

  // 描述（含标题拼接）填写：回读校验 + execCommand 兜底，失败抛错中止发布（#34）。
  // 抛错交给上层失败上报/自动重试，避免静默发出空标题/空简介的作品。
  try {
    const text = buildPlatformVideoText("快手", data.data);
    descFillText = composeKsFillText(text);
    await fillKsDescription(page, descFillText);
  } catch (e) {
    console.error("❌ 快手描述填写失败:", e?.message || e);
    throw e;
  }
  try {
    await page.click(".ant-checkbox-group>label:nth-of-type(2)", {
      delay: 200,
    });
  } catch (e) {
    console.error("❌ 输入标签失败", e);
  }

  // 选择创作声明（快手只支持 AI 生成 / 演绎情节，其它值跳过）
  try {
    await selectKsCreativeStatement(page, data);
  } catch (e) {
    console.warn("快手创作声明选择未完成:", e?.message || e);
  }

  try {
    // 用 pollPageUntil 替代 waitForSelector，避免 puppeteer 默认 protocolTimeout
    // (约 180s) 在大文件/弱网下把单次 Runtime.callFunctionOn 砍掉。
    await pollPageUntil(
      page,
      () => !!document.querySelector("#preview-tours video"),
      WAIT_UPLOAD_PROCESSING_MS,
      2000,
      "等待快手视频上传完成超时"
    );

    // 自定义封面：仅当传入 coverPath；失败抛错中止本次发布
    // （封面是缩略图点击的命脉，不允许静默跳过——与抖音流程同策略）
    const coverPath = data.data && data.data.coverPath;
    if (coverPath) {
      await uploadKsCustomCover(page, coverPath);
    }

    await page.waitForFunction(
      (text) => {
        const bar = document.querySelector("#setting-tours + div");
        if (!bar || bar.offsetParent === null) return false;
        for (const row of bar.querySelectorAll(":scope > div")) {
          const t = row.textContent.replace(/\s+/g, "").trim();
          if (t === text) return true;
        }
        return false;
      },
      { timeout: 10000 },
      submitText
    );

    // 快手发布按钮点击：原先用 page.evaluateHandle 返回行级 div 再 puppeteer click，
    // 在 hidden window 下几何中心常落不到真正的 <button> 上，结果是"看起来点过了但没发"。
    // 改为在 evaluate 内部遍历真实 button / 行 div，直接调 DOM .click()，避开鼠标几何问题。
    // 快手草稿功能和发布一个逻辑一个是 发布 一个是取消两个字
    // 提交前最后回读一次：编辑器被页面清空/重置时中止，避免发出空标题简介的作品（#34）
    if (descFillText) {
      const landed = await readKsDescription(page);
      if (!collapseText(landed)) {
        throw new Error("提交前校验失败：快手描述编辑器为空（可能被页面重置），已中止发布");
      }
    }
    const urlBefore = readPageUrl(page);
    const clicked = await page.evaluate((text) => {
      const norm = (t) =>
        String(t || "")
          .replace(/\s+/g, "")
          .trim();
      const bar = document.querySelector("#setting-tours + div");
      if (!bar) return { ok: false, reason: "no-bar" };
      for (const btn of bar.querySelectorAll("button")) {
        if (norm(btn.textContent) === text && !btn.disabled) {
          btn.click();
          return { ok: true, via: "button" };
        }
      }
      for (const row of bar.querySelectorAll(":scope > div")) {
        if (norm(row.textContent) === text) {
          const inner = row.querySelector("button,[role='button']");
          if (inner) {
            inner.click();
            return { ok: true, via: "row>inner" };
          }
          row.click();
          return { ok: true, via: "row" };
        }
      }
      return { ok: false, reason: "no-match" };
    }, submitText);
    if (!clicked || !clicked.ok) {
      throw new Error(`未找到${submitText}按钮(${clicked && clicked.reason})`);
    }
    console.log(
      isDraftMode
        ? `✅ 快手视频已保存草稿，click via=${clicked.via}`
        : `✅ 快手视频已触发发布，click via=${clicked.via}`
    );
    await replyPublishOutcome({
      page,
      data,
      window,
      event,
      urlBefore,
      isDraftMode,
      successMessage: isDraftMode ? "保存草稿成功" : "上传成功",
    });
  } catch (e) {
    // 失败瞬间截图留证（登录过期 / 风控弹窗 / 元素改版都能一眼看出）
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message: "上传失败",
    });
    console.error("❌ 发布失败", e);
  }
}
