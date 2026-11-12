#!/usr/bin/env node
// Converts a Postman collection with one embedded-WAV request per audio into:
//   1. a data-driven collection with a single translate request, and
//   2. an Iteration data JSON file (one row per audio).
// Usage: node scripts/postman-build-iteration-data.mjs <source-collection.json> <output-dir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [source, outDir] = process.argv.slice(2);
if (!source || !outDir) {
  console.error("Usage: node scripts/postman-build-iteration-data.mjs <source-collection.json> <output-dir>");
  process.exit(1);
}

const BOUNDARY = "postman-audio-performance-20261027";
const collection = JSON.parse(readFileSync(source, "utf8"));
const folder = collection.item.find(item => Array.isArray(item.item) && item.item.some(child => child.request?.body?.raw));
if (!folder) throw new Error("No folder with embedded audio requests found.");

const rows = folder.item.map(item => {
  const raw = item.request.body.raw;
  const filename = /filename="([^"]+)"/.exec(raw)?.[1];
  const language = /name="sourceLanguage"\r\n\r\n([^\r]*)\r\n/.exec(raw)?.[1] || "vi";
  const start = raw.indexOf("\r\n\r\n") + 4;
  const end = raw.indexOf(`\r\n--${BOUNDARY}`, start);
  if (!filename || start < 4 || end < 0) throw new Error(`Cannot parse multipart body of "${item.name}".`);
  const audioBase64 = raw.slice(start, end);
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(audioBase64)) throw new Error(`Audio part of "${item.name}" is not base64.`);
  return { audioName: filename, sourceLanguage: language, audioBase64 };
});

const body = [
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="audio"; filename="{{audioName}}"',
  "Content-Type: audio/wav",
  "Content-Transfer-Encoding: base64",
  "",
  "{{audioBase64}}",
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="sourceLanguage"',
  "",
  "{{sourceLanguage}}",
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="clientId"',
  "",
  "{{clientId}}",
  `--${BOUNDARY}--`,
  "",
].join("\r\n");

const script = lines => ({ type: "text/javascript", exec: lines });

// Each virtual user registers one installation lazily and reuses it for every
// iteration. Registration is rate limited (12/min by default), so it must not
// run per iteration. A token pasted into the accessToken variable is shared by
// all virtual users and skips registration entirely.
const collectionPrerequest = [
  "(function () {",
  "const baseUrl = pm.collectionVariables.get(\"baseUrl\") || \"\";",
  "if (!/^https?:\\/\\//i.test(baseUrl)) throw new Error(\"baseUrl must start with http:// or https://\");",
  "const expiresAt = Date.parse(pm.collectionVariables.get(\"accessTokenExpiresAt\") || \"\");",
  "const token = pm.collectionVariables.get(\"accessToken\");",
  "if (token && (!Number.isFinite(expiresAt) || expiresAt - Date.now() > 60000)) return;",
  "if (!pm.collectionVariables.get(\"clientId\") || !pm.collectionVariables.get(\"installationSecret\")) {",
  " pm.collectionVariables.set(\"clientId\", \"web_postman_\" + pm.variables.replaceIn(\"{{$guid}}\"));",
  " pm.collectionVariables.set(\"installationSecret\", pm.variables.replaceIn(\"{{$guid}}{{$guid}}\").replace(/-/g, \"\"));",
  "}",
  "pm.sendRequest({",
  " url: baseUrl + \"/api/installations/register\",",
  " method: \"POST\",",
  " header: { \"Content-Type\": \"application/json\", Accept: \"application/json\" },",
  " body: { mode: \"raw\", raw: JSON.stringify({",
  "  clientId: pm.collectionVariables.get(\"clientId\"), platform: \"web\",",
  "  installationSecret: pm.collectionVariables.get(\"installationSecret\"), appVersion: \"postman-iteration-data-1.0\" }) }",
  "}, function (err, res) {",
  " let data = null;",
  " try { data = res && res.json(); } catch (_) {}",
  " if (err || !res || res.code !== 201 || !data || !data.accessToken) {",
  "  console.error(\"Register installation failed\", { status: res && res.code, error: data && data.error && data.error.code });",
  "  return;",
  " }",
  " pm.collectionVariables.set(\"clientId\", data.clientId);",
  " pm.collectionVariables.set(\"accessToken\", data.accessToken);",
  " pm.collectionVariables.set(\"accessTokenExpiresAt\", data.accessTokenExpiresAt || \"\");",
  "});",
  "})();",
];

const requestPrerequest = [
  "(function () {",
  "if (!pm.iterationData.has(\"audioBase64\") || !pm.iterationData.has(\"audioName\")) {",
  " throw new Error(\"Select the audio Iteration data file (audioName, sourceLanguage, audioBase64).\");",
  "}",
  "if (!pm.iterationData.has(\"sourceLanguage\")) pm.variables.set(\"sourceLanguage\", \"vi\");",
  "})();",
];

const requestTests = [
  "(function () {",
  "let data = null;",
  "try { data = pm.response.json(); } catch (_) {}",
  "const requestId = pm.response.headers.get(\"X-Request-Id\") || \"unknown\";",
  "const audioName = pm.iterationData.get(\"audioName\");",
  "const reason = data && data.error ? data.error.code + \": \" + data.error.message : \"No valid translation result\";",
  "const detail = data && data.error && data.error.details ? \" | reason=\" + data.error.details.reason : \"\";",
  "pm.test(\"Response is JSON\", function () { pm.response.to.be.json; });",
  "pm.test(\"Request ID is returned\", function () { pm.expect(requestId).to.not.eql(\"unknown\"); });",
  "pm.test(\"Audio translation HTTP 200\", function () {",
  " pm.expect(pm.response.code, reason + detail + \" | audio=\" + audioName + \" | requestId=\" + requestId).to.eql(200);",
  "});",
  "pm.test(\"No server error (5xx)\", function () { pm.expect(pm.response.code).to.be.below(500); });",
  "if (pm.response.code === 429) {",
  " pm.test(\"429 includes Retry-After\", function () { pm.expect(pm.response.headers.get(\"Retry-After\")).to.be.a(\"string\").and.not.empty; });",
  "}",
  "if (pm.response.code === 200) {",
  " pm.test(\"Nonempty English translation\", function () {",
  "  pm.expect(data.targetLanguage).to.eql(\"en\");",
  "  pm.expect(data.englishText).to.be.a(\"string\");",
  "  pm.expect(data.englishText.trim().length).to.be.above(0);",
  " });",
  " console.info(\"Audio result\", { audio: audioName, requestId: requestId, englishText: data.englishText });",
  "} else {",
  " console.error(\"Audio failed\", { audio: audioName, status: pm.response.code, requestId: requestId, reason: reason + detail });",
  "}",
  "// An expired or revoked token forces this virtual user to register again next iteration.",
  "if (pm.response.code === 401) { pm.collectionVariables.unset(\"accessToken\"); pm.collectionVariables.unset(\"accessTokenExpiresAt\"); }",
  "})();",
];

const baseUrl = collection.variable?.find(v => v.key === "baseUrl")?.value || "https://api.hoamytech.com";
const out = {
  info: {
    name: `${collection.info.name} - Iteration data`,
    description: [
      "Một request dịch audio, mỗi lượt lấy một dòng trong file Iteration data (audioName, sourceLanguage, audioBase64).",
      "Chạy: Run → Performance, chọn Iteration data = file audio-iteration-data.json.",
      "Mỗi virtual user tự đăng ký installation một lần rồi dùng lại token. API đăng ký giới hạn khoảng 12 lượt/phút;",
      "khi chạy nhiều VU, dán sẵn accessToken (lấy từ collection functional, bước 03) vào biến accessToken để tất cả VU dùng chung.",
      "Không lưu token admin, Cloudflare hoặc Redis trong collection này.",
    ].join("\n"),
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: ["baseUrl", "clientId", "installationSecret", "accessToken", "accessTokenExpiresAt"]
    .map(key => ({ key, value: key === "baseUrl" ? baseUrl : "", type: "string" })),
  event: [{ listen: "prerequest", script: script(collectionPrerequest) }],
  item: [{
    name: "Translate {{audioName}} (Iteration data)",
    request: {
      method: "POST",
      auth: { type: "bearer", bearer: [{ key: "token", value: "{{accessToken}}", type: "string" }] },
      header: [
        { key: "Content-Type", value: `multipart/form-data; boundary=${BOUNDARY}`, type: "text" },
        { key: "Accept", value: "application/json", type: "text" },
        { key: "X-Request-Id", value: "postman-perf-{{$guid}}", type: "text" },
      ],
      body: { mode: "raw", raw: body },
      url: "{{baseUrl}}/api/audio/translate",
      description: "Audio lấy từ Iteration data; mỗi dòng là một file WAV mã hóa base64.",
    },
    event: [
      { listen: "prerequest", script: script(requestPrerequest) },
      { listen: "test", script: script(requestTests) },
    ],
  }],
};

mkdirSync(outDir, { recursive: true });
const collectionPath = join(outDir, "Audio-Translation-Iteration-Data.postman_collection.json");
const dataPath = join(outDir, "audio-iteration-data.json");
writeFileSync(collectionPath, JSON.stringify(out, null, 2));
writeFileSync(dataPath, JSON.stringify(rows));
console.log(`Wrote ${collectionPath}`);
console.log(`Wrote ${dataPath} (${rows.length} rows)`);
