"use strict";
/**
 * 本地 OpenAI 兼容模拟服务，用于不花钱自测「AI 设置 / AI 生成」：
 *   node scripts/ai-mock-server.js            # 默认端口 18080
 * 设置页填：接口地址 http://127.0.0.1:18080/v1，模型 mock-model，API Key sk-mock-123456
 * 其他 Key 会返回 401，便于验证错误提示。
 */
const http = require("http");

const VALID_KEY = "sk-mock-123456";

function reply(prompt) {
  if (/JSON 字符串数组/.test(prompt)) return '```json\n["周末去哪儿","户外徒步","治愈系风景","城市周边游","vlog日常"]\n```';
  if (/简介|正文/.test(prompt.split("任务：")[1] || "")) {
    return "周末和朋友去爬山，一路上风景超美🌿\n\n山顶的日落真的太治愈了，推荐大家试试这条路线。\n\n记得带好水和防晒哦～";
  }
  return "标题：《周末爬山⛰️看到了最美的日落》";
}

function createMockServer({ validKey = VALID_KEY, delayMs = 300 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        return send(404, { error: { message: "Not found" } });
      }
      let json = {};
      try { json = JSON.parse(body); } catch (_) { return send(400, { error: { message: "bad json" } }); }
      requests.push({ headers: req.headers, body: json });
      const auth = String(req.headers.authorization || "");
      if (auth !== `Bearer ${validKey}`) {
        // 模拟真实服务商：错误信息里回显了 Key，客户端必须打码
        return send(401, { error: { message: `Incorrect API key provided: ${auth.replace(/^Bearer /, "")}` } });
      }
      if (json.model === "missing-model") return send(404, { error: { message: "model not found" } });
      const prompt = (json.messages || []).map((m) => m.content).join("\n");
      setTimeout(() => !res.writableEnded && !res.destroyed && send(200, {
        id: "mock", object: "chat.completion", model: json.model,
        choices: [{ index: 0, message: { role: "assistant", content: reply(prompt) }, finish_reason: "stop" }],
      }), server.delayMs);
    });
  });
  server.requests = requests;
  server.delayMs = delayMs;
  return server;
}

module.exports = { createMockServer, VALID_KEY };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 18080);
  createMockServer({ delayMs: 1200 }).listen(port, "127.0.0.1", () => {
    console.log(`AI mock server: http://127.0.0.1:${port}/v1  key=${VALID_KEY}  model=任意`);
  });
}
