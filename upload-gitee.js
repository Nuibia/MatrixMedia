const https = require("https");
const path = require("path");
const package = require("./package.json");
const fs = require("fs");
const FormData = require("form-data");
const agent = new https.Agent({
  rejectUnauthorized: false, // 仅测试环境使用
});
// 获取命令行参数
const args = process.argv.slice(2);
let access_token = args[0];
let name = args[1];
const releaseBodyFromEnv = process.env.RELEASE_BODY;
let owner = "gzlingyi_0";
// 保留最近的 Release 数量，超过则删除最旧的
let saveVision = 2
let repo = "pubtw";
let target_commitish = "main";
let baseUrl = "gitee.com";
const releaseBody =
  typeof releaseBodyFromEnv === "string" && releaseBodyFromEnv.trim()
    ? releaseBodyFromEnv
    : "Release for " + name;
// 创建仓release post
let createReleaseApi = `/api/v5/repos/${owner}/${repo}/releases`;
let pushBody = {
  access_token,
  tag_name: "v" + name,
  tag: "v" + name,
  name: "v" + name,
  body: releaseBody,
  target_commitish,
};

// 先清理旧 Release 再发布：Gitee 附件配额按仓库总量计算（1 GB），
// 删除与上传若并发进行，上传时旧附件还没释放配额，会以 400 超出配额失败。
main();

async function main() {
  try {
    await pruneOldReleases();
  } catch (e) {
    // 清理失败不阻断发布，新版本照常创建，附件能传几个传几个
    console.error("清理旧 Release 失败，继续发布:", (e && e.message) || e);
  }
  createRelease();
}

/** 额外文件路径：node upload-gitee.js <token> <version> [file ...]（上传 .exe / .dmg / .AppImage） */
function resolveUploadPaths() {
  const extra = args.slice(2).filter((a) => a && a !== "--");
  if (extra.length > 0) {
    return extra
      .map((f) => path.resolve(f))
      // 与 pushall.js collectArtifacts 的口径一致：.exe / .dmg / .tar.gz
      // （tar.gz 走 linux 便携包；AppImage 因常超 100MB 由 pushall 侧过滤，不进这里）
      .filter((fp) => /\.(exe|dmg|AppImage|tar\.gz)$/i.test(fp));
  }
  const buildDir = path.join(__dirname, "build");
  const raw = path.join(
    buildDir,
    package.build.productName + " Setup " + name + ".exe"
  );
  const renamed = path.join(buildDir, "Setup " + name + ".exe");
  fs.renameSync(raw, renamed);
  return [renamed];
}

function uploadSingleFile(releaseId, filePath) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("access_token", access_token);
    formData.append("file", fs.createReadStream(filePath));

    const options = {
      hostname: baseUrl,
      path: createReleaseApi + `/${releaseId}/attach_files`,
      method: "POST",
      agent,
      headers: {
        ...formData.getHeaders(),
        "User-Agent": "Node.js",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 201) {
          console.log("文件上传成功:", filePath);
          resolve();
        } else {
          reject(new Error(`文件上传失败 ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(1000 * 60 * 20, () => {
      req.destroy(new Error("Upload timeout: 20 minutes exceeded"));
      reject(new Error("上传超时"));
    });
    formData.pipe(req);
  });
}

function collectExistingAssetNames(assets) {
  if (!Array.isArray(assets)) return [];
  return assets.map((a) => a && a.name).filter(Boolean);
}

function patchReleaseBody(releaseId, done) {
  const fromCi =
    typeof releaseBodyFromEnv === "string" && releaseBodyFromEnv.trim();
  if (!fromCi) {
    done();
    return;
  }
  const payload = JSON.stringify({
    access_token,
    tag_name: "v" + name,
    tag: "v" + name,
    name: "v" + name,
    body: releaseBody,
    target_commitish,
  });
  const options = {
    hostname: baseUrl,
    path: `${createReleaseApi}/${releaseId}`,
    method: "PATCH",
    agent,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "User-Agent": "Node.js",
    },
  };
  const req = https.request(options, (res) => {
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
    });
    res.on("end", () => {
      if (res.statusCode === 200) {
        console.log("已更新 Gitee Release 说明文案");
      } else {
        console.error(
          "更新 Release 说明失败:",
          res.statusCode,
          buf.slice(0, 500)
        );
      }
      done();
    });
  });
  req.on("error", (err) => {
    console.error("PATCH release body:", err.message);
    done();
  });
  req.write(payload);
  req.end();
}

async function uploadAllFiles(releaseId, existingAssets) {
  const existingNames = new Set(collectExistingAssetNames(existingAssets));
  let paths;
  try {
    paths = resolveUploadPaths();
  } catch (e) {
    console.error("准备上传文件失败:", e.message);
    throw e;
  }
  for (const fp of paths) {
    if (!fs.existsSync(fp)) {
      console.error("文件不存在，跳过:", fp);
      continue;
    }
    const fileName = path.basename(fp);
    if (existingNames.has(fileName)) {
      console.log("已存在同名附件，跳过上传:", fileName);
      continue;
    }
    console.log("开始上传", fp);
    await uploadSingleFile(releaseId, fp);
  }
}

// 创建标签
function createRelease() {
  const options = {
    hostname: baseUrl,
    path: createReleaseApi,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // 可能还需要其他标头，比如授权信息
    },
    body: JSON.stringify(pushBody),
  };
  let data = "";
  const req = https.request(options, (res) => {
    // 捕获数据流
    res.on("data", (chunk) => {
      data += chunk;
    });
    // 在数据流结束时处理数据
    res.on("end", () => {
      if (res.statusCode === 201) {
        const rel = JSON.parse(data);
        console.log("创建仓库成功", rel.id);
        uploadAllFiles(rel.id, rel.assets).catch((err) => {
          console.error("上传附件失败:", err.message || err);
          process.exitCode = 1;
        });
      } else {
        console.error("创建失败:", res.statusCode, data, options);
        if (data.indexOf("该标签已经存在发行版") != -1) {
          tgaGetRelease((releaseData) => {
            console.log("获取release_id", releaseData.id);
            patchReleaseBody(releaseData.id, () => {
              uploadAllFiles(releaseData.id, releaseData.assets).catch(
                (err) => {
                  console.error("上传附件失败:", err.message || err);
                  process.exitCode = 1;
                }
              );
            });
          });
        }
      }
    });
  });
  req.on("error", (error) => {
    console.error("创建失败:", error);
  });
  req.write(JSON.stringify(pushBody));
  req.end();
}

// 标签获取
function tgaGetRelease(callback) {
  const options = {
    hostname: baseUrl,
    path:
      createReleaseApi +
      "/tags/" +
      pushBody.tag +
      "?access_token=" +
      access_token,
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      // 可能还需要其他标头，比如授权信息
    },
  };
  const req = https.request(options, (res) => {
    let data = "";

    res.on("data", (chunk) => {
      data += chunk;
    });

    res.on("end", () => {
      callback(JSON.parse(data));
    });
  });

  req.on("error", (error) => {
    console.error("Error fetching releases:", error);
  });

  req.end();
}

// 获取所有 Releases
function getAllReleases() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: baseUrl,
      path:
        createReleaseApi + "?page=1&per_page=100&access_token=" + access_token,
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        // 可能还需要其他标头，比如授权信息
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("解析 Release 列表失败: " + data.slice(0, 200)));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function deleteRelease(id) {
  return new Promise((resolve) => {
    const options = {
      hostname: baseUrl,
      path: createReleaseApi + `/${id}?access_token=${access_token}`,
      method: "DELETE",
    };
    const req = https.request(options, (res) => {
      res.resume();
      if (res.statusCode === 204) {
        console.log("删除成功:", id);
      } else {
        console.error("删除 Release 失败:", id, res.statusCode);
      }
      // 单个删除失败不阻断，继续删其余的
      resolve();
    });
    req.on("error", (error) => {
      console.error("删除 Release 出错:", id, error.message || error);
      resolve();
    });
    req.end();
  });
}

/**
 * 只保留最近 saveVision 个 Release（含本次要发的版本），多余的从最旧开始删。
 *
 * 注意三点旧实现的坑：
 * 1. 接口返回顺序无保证（一般新的在前），不能直接取 [0] 当最旧，按 created_at 排序；
 * 2. 不能只删一个——存量超配额时新附件依然传不上去，要删到达标为止；
 * 3. 本次 tag 可能已存在（上次发布中途失败重跑），清理时要把它排除在外，
 *    否则重跑会把上一个可用版本也删掉。
 */
async function pruneOldReleases() {
  const releases = await getAllReleases();
  if (!Array.isArray(releases) || releases.length === 0) {
    console.log("当前没有任何 Release，跳过删除");
    return;
  }
  console.log("已有 Release 数量:", releases.length);
  // 除本次要发的版本外，其余按创建时间升序，最旧的排在前面
  const others = releases.filter((rel) => rel.tag_name !== pushBody.tag);
  const sorted = [...others].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );
  const needDelete = sorted.length - (saveVision - 1);
  if (needDelete <= 0) {
    console.log("不需要删除");
    return;
  }
  for (const rel of sorted.slice(0, needDelete)) {
    console.log("删除旧 Release:", rel.tag_name || rel.name || rel.id);
    await deleteRelease(rel.id);
  }
}
