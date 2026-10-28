import path from "path";
import fs from "fs";
import maybeClosePublishWindow from "./closeWindow.js";
import { resolveVideoLinkOption } from "../../../shared/videoLink.js";
import {
  isCreativeStatementNone,
  resolveSphCreativeStatementLabel,
} from "../../../shared/creativeStatement.js";
import { attachSphVideoLink } from "./sphLink.js";
import {
  WAIT_SELECTOR_APPEAR_MS,
  WAIT_UPLOAD_PROCESSING_MS,
  pollPageUntil,
} from "./uploadTimeouts.js";
import { buildPlatformVideoText } from "../../../shared/videoMetadata.js";
import {
  readPageUrl,
  replyPublishFailure,
  replyPublishOutcome,
} from "./publishOutcome.js";

const SEL_ORIGINAL_CHECKBOX =
  "wujie-app.wujie_iframe >>> .declare-original-checkbox .ant-checkbox-wrapper";
const SEL_ORIGINAL_DIALOG_CHECK =
  "wujie-app.wujie_iframe >>> .declare-original-dialog .weui-desktop-dialog label.ant-checkbox-wrapper";
const SEL_ORIGINAL_DIALOG_OK =
  "wujie-app.wujie_iframe >>> .declare-original-dialog .weui-desktop-dialog button.weui-desktop-btn_primary";

/**
 * 声明原创：部分账号/版本无入口或已默认处理，失败不影响后续发布。
 */
async function tryDeclareOriginal(page) {
  let yInput;
  try {
    yInput = await page.waitForSelector(SEL_ORIGINAL_CHECKBOX, {
      timeout: 3000,
    });
  } catch (_) {
    console.log("声明原创：未找到勾选入口，跳过");
    return;
  }

  try {
    await yInput.click();
  } catch (e) {
    console.warn(
      "声明原创：勾选入口点击失败，跳过",
      e && e.message ? e.message : e
    );
    return;
  }

  try {
    await page.waitForSelector(
      "wujie-app.wujie_iframe >>> .weui-desktop-dialog__bd .protocol-text",
      { timeout: 2500 }
    );
    const protocol = await page.$(
      "wujie-app.wujie_iframe >>> .weui-desktop-dialog__bd .protocol-text"
    );
    if (protocol) await protocol.click();
    await page.waitForTimeout(300);
    const clicked = await page.evaluate(() => {
      const app = document.querySelector("wujie-app.wujie_iframe");
      if (!app || !app.shadowRoot) return false;
      const bodies = app.shadowRoot.querySelectorAll(
        ".weui-desktop-dialog__bd"
      );
      for (const body of bodies) {
        const dlg = body.closest(".weui-desktop-dialog") || body.parentElement;
        const btns = (dlg || body).querySelectorAll(
          "button.weui-desktop-btn_primary"
        );
        for (const btn of btns) {
          if (
            String(btn.textContent || "")
              .trim()
              .includes("声明原创")
          ) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });
    if (clicked) await page.waitForTimeout(800);
  } catch (_) {
    /* 非首次账号或协议弹窗未出现 */
  }

  try {
    const cBox = await page.waitForSelector(SEL_ORIGINAL_DIALOG_CHECK, {
      timeout: 3000,
    });
    await cBox.click();
    const aBtn = await page.waitForSelector(SEL_ORIGINAL_DIALOG_OK, {
      timeout: 3000,
    });
    await aBtn.click();
  } catch (_) {
    console.log("声明原创：未出现后续确认框或已完成，跳过");
  }
}

/**
 * 视频号自定义封面（探针实证配方）：
 * 点 .vertical-cover-wrap 槽位 → weui-desktop-dialog「编辑封面」→「上传封面」→
 * .single-cover-uploader-wrap 内隐藏 file input（accept=jpeg/jpg/png，勿传 webp）注入 →
 * 「确定」→ 校验 .cover-img-vertical 槽位 img src 变化 + 弹窗已关闭。
 * 封面为「个人主页和分享卡片(3:4)」——3:4 竖图（如 1080x1440）恰好匹配。
 */
async function uploadSphCustomCover(page, coverPath) {
  if (!fs.existsSync(coverPath)) {
    throw new Error(`封面文件不存在: ${coverPath}`);
  }

  const srcBefore = await page.evaluate(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    const img = root && root.querySelector(".cover-img-vertical");
    return img ? img.src : "";
  });

  const opened = await page.evaluate(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return false;
    const slot =
      root.querySelector(".vertical-cover-wrap") ||
      root.querySelector(".cover-preview-wrap");
    if (!slot) return false;
    slot.click();
    return true;
  });
  if (!opened) throw new Error("未找到视频号封面编辑入口（.vertical-cover-wrap）");

  // 等「编辑封面」弹窗可见
  await page.waitForFunction(
    () => {
      const app = document.querySelector("wujie-app.wujie_iframe");
      const root = app && app.shadowRoot;
      if (!root) return false;
      for (const d of root.querySelectorAll(".weui-desktop-dialog")) {
        const t = (d.textContent || "").replace(/\s+/g, "");
        const r = d.getBoundingClientRect();
        if (t.includes("编辑封面") && r.width > 0) return true;
      }
      return false;
    },
    { timeout: 15000 }
  );
  await page.waitForTimeout(1200);

  // 切到「上传封面」
  const tabbed = await page.evaluate(() => {
    const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return false;
    const dlg = [...root.querySelectorAll(".weui-desktop-dialog")].find(
      (d) =>
        (d.textContent || "").includes("编辑封面") &&
        d.getBoundingClientRect().width > 0
    );
    if (!dlg) return false;
    for (const el of dlg.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || el.children.length > 2) continue;
      if (norm(el.textContent) === "上传封面") {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!tabbed) throw new Error("视频号封面弹窗内未找到「上传封面」入口");
  await page.waitForTimeout(1200);

  // 注入图片文件（探针实证：input 挂 .single-cover-uploader-wrap，隐藏可注入）
  const inputHandle = await page.evaluateHandle(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return null;
    return (
      root.querySelector('.single-cover-uploader-wrap input[type="file"]') ||
      [...root.querySelectorAll('input[type="file"]')].find((i) =>
        /image/.test(i.accept || "")
      ) ||
      null
    );
  });
  const inputEl = inputHandle.asElement();
  if (!inputEl) throw new Error("未找到视频号封面上传 file input");
  await inputEl.uploadFile(path.resolve(coverPath));
  console.log("[sph] 封面文件已注入上传区:", coverPath);

  // 等上传+裁剪视图落定（1080x1440 与 3:4 槽位同比，通常无强制裁剪步骤）
  await page.waitForTimeout(5000);

  // 点「确定」（兜底再试「确认」）
  const confirmed = await page.evaluate(() => {
    const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return { ok: false, reason: "no-shadow" };
    const dlg = [...root.querySelectorAll(".weui-desktop-dialog")].find(
      (d) =>
        (d.textContent || "").includes("编辑封面") &&
        d.getBoundingClientRect().width > 0
    );
    if (!dlg) return { ok: false, reason: "no-dialog" };
    for (const label of ["确定", "确认"]) {
      for (const b of dlg.querySelectorAll(
        "button,.weui-desktop-btn,[role='button']"
      )) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && !b.disabled && norm(b.textContent) === label) {
          b.click();
          return { ok: true, label };
        }
      }
    }
    return { ok: false, reason: "no-确定/确认" };
  });
  if (!confirmed.ok) {
    throw new Error(`视频号封面弹窗确认失败: ${confirmed.reason}`);
  }
  console.log("[sph] 封面弹窗已点「" + confirmed.label + "」");
  await page.waitForTimeout(3500);

  // 校验：弹窗已关 + 槽位 img src 相对设置前变化；微信 CDN 域名为强信号
  const after = await page.evaluate(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return { src: "", dialogOpen: false };
    const img = root.querySelector(".cover-img-vertical");
    const dlg = [...root.querySelectorAll(".weui-desktop-dialog")].find(
      (d) =>
        (d.textContent || "").includes("编辑封面") &&
        d.getBoundingClientRect().width > 0
    );
    return { src: img ? img.src : "", dialogOpen: !!dlg };
  });
  const changed = !!after.src && after.src !== srcBefore;
  if (!changed) {
    throw new Error(
      `视频号封面设置后槽位图片未变化（src=${(after.src || "").slice(0, 120)}, 弹窗仍开=${after.dialogOpen}）`
    );
  }
  const cdn = /qpic|weixin|wechat|wx\.qq|qq\.com/.test(after.src);
  console.log(
    `[sph] 自定义封面已设置并校验通过（src变化=true, CDN=${cdn}, 弹窗已关=${!after.dialogOpen}）: ${after.src.slice(0, 120)}`
  );
  if (after.dialogOpen) {
    console.warn("[sph] ⚠️ 封面弹窗未关闭，尝试 Esc 收敛");
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1000);
  }
}

/**
 * 选择视频号「视频标注」（.post-with-mark-tag）。
 * 自行拍摄时间/地点、转载来源为平台选填，本轮只点主选项。
 */
async function applySphCreativeStatement(page, value) {
  if (isCreativeStatementNone(value)) return;
  const label = resolveSphCreativeStatementLabel(value);
  if (!label || label === "无标注" || label === "无需标注") return;

  const opened = await page.evaluate(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return false;
    const trigger = root.querySelector(".post-with-mark-tag .select-display");
    if (!trigger) return false;
    trigger.click();
    return true;
  });
  if (!opened) {
    console.log("视频标注：未找到入口，跳过");
    return;
  }

  await page.waitForTimeout(300);
  const clicked = await page.evaluate((expected) => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return false;
    const options = Array.from(root.querySelectorAll(".mark-tag-option"));
    const target = options.find((item) => {
      const main = item.querySelector(".option-main");
      return String((main && main.textContent) || "").trim() === expected;
    });
    if (!target) return false;
    target.click();
    return true;
  }, label);
  if (!clicked) {
    console.warn(`视频标注：未找到选项「${label}」，跳过`);
    return;
  }
  console.log(`[sph][mark-tag] 已选择：${label}`);
  await page.waitForTimeout(400);
}

async function clickSphDraftButton(page) {
  const draftBtn = await page.waitForSelector(
    "wujie-app.wujie_iframe >>> .form-btns>div:first-child button",
    { timeout: WAIT_SELECTOR_APPEAR_MS }
  );
  if (!draftBtn) throw new Error("未找到视频号保存草稿按钮");
  await draftBtn.click({ delay: 200 });
  await page.waitForTimeout(1000);
}

async function clickSphPublishButton(page) {
  const publishBtn = await page.waitForSelector(
    "wujie-app.wujie_iframe >>> .form-btns>div:last-child button",
    { timeout: WAIT_SELECTOR_APPEAR_MS }
  );
  if (!publishBtn) throw new Error("未找到视频号发布按钮");
  await publishBtn.click({ delay: 200 });
  await page.waitForTimeout(1000);
}

async function waitSphUploadProcessing(page) {
  await pollPageUntil(
    page,
    () => {
      const app = document.querySelector("wujie-app.wujie_iframe");
      if (!app || !app.shadowRoot) return false;
      const tag = app.shadowRoot.querySelector(".tag-inner");
      return !!(tag && tag.textContent.trim() === "删除");
    },
    WAIT_UPLOAD_PROCESSING_MS,
    2000,
    "等待视频处理超时（未出现「删除」标签）"
  );
  await page.waitForTimeout(2000);
}

async function fallbackLinkFailureToDraft(page, data, window, event, error) {
  const detail =
    (error && error.message) ||
    (typeof error === "string" ? error : String(error));
  try {
    // 链接在表单前半段填写；失败时仍需等待视频处理完成后才能可靠保存草稿。
    await waitSphUploadProcessing(page);
    await clickSphDraftButton(page);
    event.reply("puppeteerFile-done", {
      ...data,
      status: true,
      outcome: "draft_saved",
      publishMode: "draft",
      publishToDraft: true,
      needsAttention: true,
      failureStage: "video_link",
      message: `视频号链接添加失败，视频已保存为草稿：${detail}`,
    });
    maybeClosePublishWindow({ ...data, closeWindowAfterPublish: true }, window);
    return true;
  } catch (draftError) {
    const draftDetail =
      (draftError && draftError.message) || String(draftError || "未知错误");
    throw new Error(
      `视频号链接添加失败：${detail}；保存草稿也失败：${draftDetail}`
    );
  }
}

export default async function (page, data, window, event, onFinish) {
  const isDraftMode =
    data.publishMode === "draft" || data.publishToDraft === true;

  console.log(data);
  await page.waitForTimeout(1000 * 5);
  try {
    const sel = 'wujie-app.wujie_iframe >>> input[type="file"]';

    const uploadInput = await page.waitForSelector(sel, {
      timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    if (!uploadInput) throw new Error("上传 input 不存在");
    await uploadInput.uploadFile(path.resolve(data.filePath));
    await uploadInput.evaluate((el) => {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  } catch (err) {
    console.error("❌ 文件上传失败:", err);
  }

  try {
    const text = buildPlatformVideoText("视频号", data.data);
    const titleInput = await page.waitForSelector(
      "wujie-app.wujie_iframe >>> .post-desc-box .input-editor",
      { timeout: WAIT_SELECTOR_APPEAR_MS }
    );
    // 传统input/textarea的操作
    await titleInput.click();
    if (text.description) {
      await page.keyboard.type(text.description, { delay: 50 });
    }
    const shortTitle = text.shortTitle;
    if (shortTitle) {
      const sel2 =
        'wujie-app.wujie_iframe >>> input[placeholder="填写短标题有机会获得更多流量"]';
      const uploadInput2 = await page.waitForSelector(sel2, {
        timeout: WAIT_SELECTOR_APPEAR_MS,
      });
      await uploadInput2.click();
      let newBt = shortTitle.replace(/[，。、\/,;:!?'"()\[\]{}<>]/g, " ");
      await page.keyboard.type(newBt, { delay: 50 });
    } else {
      console.log("视频号短标题未填写，跳过");
    }
  } catch (err) {
    console.error("❌ 输入失败:", err);
  }

  try {
    const link = resolveVideoLinkOption("视频号", data.publishOptions);
    if (link && link.enabled === true) {
      try {
        const selectedLink = await attachSphVideoLink(page, link);
        console.log(
          `[sph][link] 已添加 ${selectedLink.type} ${selectedLink.value}: ${
            selectedLink.label || ""
          }`
        );
      } catch (linkError) {
        console.error("[sph][link] 添加链接失败:", linkError);
        const handled = await fallbackLinkFailureToDraft(
          page,
          data,
          window,
          event,
          linkError
        );
        if (handled) return;
      }
    }

    try {
      await applySphCreativeStatement(
        page,
        data.data && data.data.creativeStatement
      );
    } catch (markError) {
      console.warn(
        "视频标注选择未完成:",
        markError && markError.message ? markError.message : markError
      );
    }

    await tryDeclareOriginal(page);
    await waitSphUploadProcessing(page);

    // 自定义封面：仅当传入 coverPath；失败抛错中止本次发布
    // （封面是缩略图点击的命脉，不允许静默跳过——与抖音流程同策略）
    const coverPath = data.data && data.data.coverPath;
    if (coverPath) {
      await uploadSphCustomCover(page, coverPath);
    }

    // 所有表单项（包括商品）完成后，草稿和发布只能二选一执行。
    const urlBefore = readPageUrl(page);
    if (isDraftMode) await clickSphDraftButton(page);
    else await clickSphPublishButton(page);
    console.log(
      isDraftMode ? "✅ 视频号视频已保存草稿" : "✅ 视频号视频上传成功"
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
  } catch (err) {
    const detail =
      (err && err.message) || (typeof err === "string" ? err : String(err));
    console.error("❌ 视频号发布失败:", err);
    // 失败瞬间截图留证（登录过期 / 风控弹窗 / 元素改版都能一眼看出）
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message:
        detail && detail.length > 400
          ? `${detail.slice(0, 400)}…`
          : detail || "上传失败",
      closeWindow: true,
    });
  }
}
