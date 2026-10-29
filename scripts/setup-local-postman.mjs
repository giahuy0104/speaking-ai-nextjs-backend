import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseUrl = "http://localhost:8080";
const environmentPath = path.join(root, "docs/postman/.env.local-cache.postman_environment.json");
const collectionPath = path.join(root, "docs/postman/Audio-Translation-Local-Cache.postman_collection.json");
const args = new Set(process.argv.slice(2));

function firstRequest(items) {
  for (const item of items) {
    if (item.request) return item.request;
    const nested = firstRequest(item.item || []);
    if (nested) return nested;
  }
}

async function main() {
  if (args.has("--help")) {
    console.info("npm run postman:local-auth [-- --verify-cache]\nRegisters one local test installation and writes a gitignored Postman environment. --verify-cache sends three audio requests to localhost:8080; a miss can call Cloudflare.");
    return;
  }
  if ([...args].some(arg => arg !== "--verify-cache")) throw new Error("Unsupported argument.");
  let previous = {};
  let environmentId = randomUUID();
  try {
    const file = JSON.parse(await readFile(environmentPath, "utf8"));
    environmentId = file.id || environmentId;
    previous = Object.fromEntries(file.values.map(value => [value.key, value.value]));
    if (previous.baseUrl !== baseUrl || !/^web_[A-Za-z0-9._:-]{8,180}$/.test(previous.clientId || "") ||
        !/^[A-Za-z0-9_-]{32,180}$/.test(previous.installationSecret || "")) throw new Error("Invalid local environment.");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Existing local Postman environment is invalid; it was not overwritten.");
  }
  const clientId = previous.clientId || `web_postman_cache_${randomUUID()}`;
  const installationSecret = previous.installationSecret || randomBytes(32).toString("base64url");
  const registration = await fetch(`${baseUrl}/api/installations/register`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json", "X-Request-Id": `local-cache-register-${randomUUID()}` },
    body: JSON.stringify({ clientId, platform: "web", installationSecret, appVersion: "local-postman-cache" }),
  });
  const session = await registration.json().catch(() => null);
  if (registration.status !== 201 || session?.clientId !== clientId ||
      typeof session.accessToken !== "string" || typeof session.refreshToken !== "string") {
    const code = typeof session?.error?.code === "string" && /^[A-Z_]+$/.test(session.error.code) ? session.error.code : "unknown";
    throw new Error(`Local registration failed: HTTP ${registration.status}, ${code}.`);
  }
  const values = { baseUrl, clientId, installationSecret, accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt, refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt };
  const secretKeys = new Set(["installationSecret", "accessToken", "refreshToken"]);
  await writeFile(environmentPath, JSON.stringify({ id: environmentId, name: "Local 8080 - Authenticated Cache",
    values: Object.entries(values).map(([key, value]) => ({ key, value, enabled: true, type: secretKeys.has(key) ? "secret" : "default" })),
    _postman_variable_scope: "environment", _postman_exported_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });

  const template = JSON.parse(await readFile(path.join(root, "docs/postman/Audio-Translation-Nginx-8080.postman_collection.json"), "utf8"));
  const request = structuredClone(firstRequest(template.item));
  const clientPart = /name="clientId"\r?\n\r?\n[^\r\n]+/;
  if (!clientPart.test(request?.body?.raw || "")) throw new Error("The embedded audio template has no clientId part.");
  request.body.raw = request.body.raw.replace(clientPart, part => part.slice(0, part.lastIndexOf("\n") + 1) + "{{clientId}}");
  request.url = "{{baseUrl}}/api/audio/translate";
  request.auth = { type: "bearer", bearer: [{ key: "token", value: "{{accessToken}}", type: "string" }] };
  request.header = request.header.filter(header => !/^authorization$/i.test(header.key));
  for (const header of request.header) if (/^x-request-id$/i.test(header.key)) header.value = "{{requestId}}";
  const events = [
    { listen: "prerequest", script: { type: "text/javascript", exec: [
      "if (!pm.environment.get('accessToken') || !pm.environment.get('clientId')) throw new Error('Chọn Environment Local 8080 - Authenticated Cache.');",
      "if (Date.parse(pm.environment.get('accessTokenExpiresAt')) <= Date.now()) throw new Error('Token đã hết hạn: chạy npm run postman:local-auth và import lại Environment.');",
      "pm.variables.set('requestId', 'postman-local-cache-' + pm.variables.replaceIn('{{$guid}}'));",
    ] } },
    { listen: "test", script: { type: "text/javascript", exec: [
      "pm.test('HTTP 200', () => pm.response.to.have.status(200));",
      "let body; try { body = pm.response.json(); } catch {}",
      "pm.test('English translation is present', () => pm.expect(body && body.englishText).to.be.a('string').and.not.empty);",
      "pm.test('Target language is English', () => pm.expect(body && body.targetLanguage).to.equal('en'));",
      "pm.test('Request ID matches', () => pm.expect(pm.response.headers.get('X-Request-Id')).to.equal(pm.variables.get('requestId')));",
      "pm.test('Cache participates', () => pm.expect(pm.response.headers.get('X-Audio-Cache')).to.be.oneOf(['hit', 'miss', 'coalesced']));",
      "console.info('local-cache-result', {status: pm.response.code, cacheStatus: pm.response.headers.get('X-Audio-Cache'), requestId: pm.response.headers.get('X-Request-Id'), responseTimeMs: pm.response.responseTime});",
    ] } },
  ];
  await writeFile(collectionPath, JSON.stringify({ info: { _postman_id: randomUUID(),
    name: "Audio Translation - Local 8080 - Authenticated Cache",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description: "Chọn Environment Local 8080 - Authenticated Cache. Audio WAV nhúng sẵn; giữ Body raw. Gửi hai lần: cache miss có thể gọi Cloudflare, lần sau hit trong TTL 300 giây. Collection chỉ có request dịch, không đăng ký/refresh token trong vòng lặp tải. Token hết hạn: chạy npm run postman:local-auth và import lại Environment. Dùng cùng installation và audio để đo cache; kết quả này không đo công suất AI với audio mới." },
    variable: [{ key: "baseUrl", value: baseUrl, type: "string" }],
    item: [{ name: "Translate embedded WAV - authenticated cache", request, event: events }],
  }, null, 2) + "\n");

  const report = { configuredAt: new Date().toISOString(), baseUrl, registrationStatus: registration.status,
    clientId, accessTokenExpiresAt: session.accessTokenExpiresAt, environmentFile: path.relative(root, environmentPath),
    collectionFile: path.relative(root, collectionPath) };
  if (args.has("--verify-cache")) {
    report.startedAt = new Date().toISOString();
    report.requests = [];
    let firstText;
    for (let index = 0; index < 3; index++) {
      const requestId = `local-cache-verify-${randomUUID()}`;
      const started = Date.now();
      const headers = Object.fromEntries(request.header.filter(h => !h.disabled).map(h => [h.key, h.value]));
      headers["X-Request-Id"] = requestId; headers.Authorization = `Bearer ${session.accessToken}`;
      const response = await fetch(`${baseUrl}/api/audio/translate`, { method: "POST", redirect: "error",
        headers, body: request.body.raw.replaceAll("{{clientId}}", clientId), signal: AbortSignal.timeout(40_000) });
      const body = await response.json().catch(() => null);
      if (index === 0) firstText = body?.englishText;
      report.requests.push({ requestId: response.headers.get("X-Request-Id"), status: response.status,
        cacheStatus: response.headers.get("X-Audio-Cache"), elapsedMs: Date.now() - started,
        resultMatchesFirst: !!firstText && body?.englishText === firstText });
    }
    report.completedAt = new Date().toISOString();
    report.cacheVerified = report.requests.every((r, i) => r.status === 200 && r.resultMatchesFirst &&
      (i === 0 ? ["miss", "hit"].includes(r.cacheStatus) : r.cacheStatus === "hit"));
    const reportPath = path.join(root, `docs/postman/reports/${report.configuredAt.slice(0, 10)}-local-cache-auth-smoke.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    if (!report.cacheVerified) process.exitCode = 1;
  }
  // Never print tokens, the per-installation secret or the server signing secret.
  console.info(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error.message?.startsWith("Local registration failed:") || error.message?.startsWith("Existing local Postman")
    ? error.message : "Local Postman setup failed. Check localhost:8080, installation auth and the embedded audio template. Credentials were not printed.");
  process.exitCode = 1;
});
