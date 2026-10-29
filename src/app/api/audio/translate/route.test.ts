import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Each child has an immutable runtime registry, actual installation auth, and
// mocked provider fetch. Only Next's server-only marker is adapted for Node.
const harness = String.raw`
const Module = require('node:module');
const load = Module._load;
Module._load = function(specifier, ...args) {
  if (specifier === 'server-only') return {};
  return load.call(this, specifier, ...args);
};
const asrModel = '@cf/openai/whisper-large-v3-turbo';
const textModel = '@cf/meta/llama-4-scout-17b-16e-instruct';
const scenario = process.env.CF_ROUTE_TEST_SCENARIO;
process.env.PERSISTENCE_BACKEND = 'local';
process.env.AUDIO_STORAGE_BACKEND = 'local';
process.env.DATABASE_URL = '';
process.env.INSTALLATION_AUTH_REQUIRED = 'true';
process.env.INSTALLATION_AUTH_SECRET = 'route-test-auth-secret-at-least-32-characters';
process.env.CLOUDFLARE_ACCOUNT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = 'legacy-secret-token';
process.env.CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED = 'true';
process.env.CLOUDFLARE_POOL_STORE = 'memory';
process.env.AUDIO_TRANSLATION_CACHE_ENABLED = 'false';
process.env.AUDIO_TRANSLATION_JOBS_ENABLED = 'false';
process.env.CLOUDFLARE_POOL_A_TOKEN = 'dedicated-secret-token';
process.env.CLOUDFLARE_ACCOUNTS_JSON = JSON.stringify([{
  alias:'audio-a',accountId:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',apiTokenEnv:'CLOUDFLARE_POOL_A_TOKEN',enabled:true,
  capabilities:{asr:[asrModel],text:[textModel]},
  limits:{asr:{rpm:60,burst:2,maxConcurrent:1},text:{rpm:60,burst:2,maxConcurrent:1},accountMaxConcurrent:1}
}]);
delete process.env.CLOUDFLARE_WORKERS_AI_MODEL;
delete process.env.CLOUDFLARE_TEXT_MODEL;
delete process.env.CLOUDFLARE_POOL_MAX_IN_FLIGHT;
const clientId = 'web_cloudflare_route_test';
const headers = { 'x-request-id': 'route-test-request-id' };
const calls = [];
const logs = [];
for (const method of ['info', 'warn']) console[method] = (...args) => {
  try { const value = JSON.parse(args[0]); if (value.event) logs.push(value); } catch {}
};
globalThis.fetch = async (url, init) => {
  calls.push({url:String(url),authorization:new Headers(init.headers).get('authorization')});
  return String(url).includes('chat/completions')
    ? Response.json({choices:[{message:{content:'I feel better.'}}]})
    : Response.json({success:true,result:{text:'I feel better.'}});
};
function request(language='en',token=true,audio=true,claim=clientId) {
  const data = new FormData();
  if (audio) data.set('audio',new File(['audio'],'speech.mp3',{type:'audio/mpeg'}));
  data.set('sourceLanguage',language);
  data.set('clientId',claim);
  return new Request('http://localhost/api/audio/translate',{
    method:'POST',headers:{'x-request-id':headers['x-request-id'],...(token?{authorization:headers.authorization}:{})},body:data
  });
}
async function result(response) {
  return {status:response.status,requestId:response.headers.get('x-request-id'),body:await response.json()};
}
(async () => {
  const { registerInstallation } = require('./src/lib/installationAuth.ts');
  const registration = await registerInstallation({clientId,platform:'web',installationSecret:'route-test-installation-secret-000000000'});
  headers.authorization = 'Bearer ' + registration.accessToken;
  const { POST } = require('./src/app/api/audio/translate/route.ts');
  let output;
  if (scenario === 'validation') {
    process.env.CLOUDFLARE_ACCOUNTS_JSON = 'private broken registry';
    const wrongType = new Request('http://localhost/api/audio/translate',{method:'POST',headers,body:'{}'});
    const responses = [];
    for (const invalid of [wrongType, request('en',false), request('invalid-language'),
      request('en',true,false), request('en',true,true,'web_different_client')]) {
      responses.push(await result(await POST(invalid)));
    }
    output = {responses};
  } else if (scenario === 'legacy') {
    process.env.CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED = 'false';
    process.env.CLOUDFLARE_ACCOUNTS_JSON = 'broken';
    process.env.CLOUDFLARE_POOL_STORE = 'redis';
    process.env.CLOUDFLARE_POOL_REDIS_URL = 'invalid';
    output = {response:await result(await POST(request()))};
  } else if (scenario === 'configuration') {
    process.env.CLOUDFLARE_ACCOUNTS_JSON = 'private broken registry';
    output = {response:await result(await POST(request()))};
  } else if (scenario === 'redis') {
    process.env.CLOUDFLARE_POOL_STORE = 'redis';
    process.env.CLOUDFLARE_POOL_REDIS_URL = 'redis://127.0.0.1:1';
    output = {response:await result(await POST(request()))};
  } else if (scenario.startsWith('diagnostic-')) {
    const kind = scenario.slice('diagnostic-'.length);
    const controller = new AbortController();
    const original = request(kind === 'text-503' ? 'vi' : 'en');
    const req = new Request(original, { signal: controller.signal });
    if (kind === 'client-upload') controller.abort(new Error('private client abort token'));
    globalThis.fetch = async (url) => {
      calls.push({url:String(url)});
      if (kind === 'client-inflight') { controller.abort(); return new Promise(() => {}); }
      if (kind === 'network') throw new Error('private URL token transcript');
      if (kind === 'unknown-abort') throw new DOMException('private abort token', 'AbortError');
      const isText = String(url).includes('chat/completions');
      if (kind === 'text-503' && !isText) return Response.json({success:true,result:{text:'Tôi cảm thấy tốt hơn.'}});
      return Response.json({success:false,errors:[{code:4006,message:'private provider message token'}]},
        {status:kind === 'asr-429' ? 429 : 503});
    };
    let pendingRequest = req;
    let keepAlive;
    if (kind === 'request-deadline') {
      process.env.CLOUDFLARE_AUDIO_TRANSLATION_TIMEOUT_MS = '5';
      pendingRequest = new Request(original.url, {method:'POST',headers:{'content-type':'multipart/form-data; boundary=diagnostic'},
        body:new ReadableStream(),duplex:'half'});
      keepAlive = setTimeout(() => {}, 1000);
    }
    try { output = {response:await result(await POST(pendingRequest))}; }
    finally { clearTimeout(keepAlive); }
  } else if (scenario === 'exhaustion') {
    let unblock;
    globalThis.fetch = async (url) => {
      calls.push({url:String(url)});
      return new Promise(resolve => {unblock=()=>resolve(Response.json({success:true,result:{text:'I feel better.'}}));});
    };
    const first = POST(request());
    for (let i=0;!unblock && i<200;i++) await new Promise(resolve=>setTimeout(resolve,5));
    if (!unblock) throw new Error('first request did not reach provider');
    const busy = await result(await POST(request()));
    unblock();
    output = {busy,first:await result(await first)};
  } else if (scenario === 'burst' || scenario === 'text-capacity') {
    process.env.CLOUDFLARE_POOL_MAX_WAIT_MS = scenario === 'burst' ? '3000' : '0';
    process.env.CLOUDFLARE_POOL_MAX_IN_FLIGHT = '4';
    process.env.CLOUDFLARE_POOL_MAX_QUEUED = '32';
    const accounts = JSON.parse(process.env.CLOUDFLARE_ACCOUNTS_JSON);
    accounts[0].limits = {asr:{rpm:60000,burst:100,maxConcurrent:2},text:{rpm:60000,burst:100,maxConcurrent:1},accountMaxConcurrent:3};
    process.env.CLOUDFLARE_ACCOUNTS_JSON = JSON.stringify(accounts);
    let asrActive=0,textActive=0,asrPeak=0,textPeak=0;
    globalThis.fetch = async (url) => {
      const text=String(url).includes('chat/completions');
      calls.push({url:String(url)});
      if(text)textPeak=Math.max(textPeak,++textActive);else asrPeak=Math.max(asrPeak,++asrActive);
      await new Promise(resolve=>setTimeout(resolve,text?25:5));
      if(text)textActive--;else asrActive--;
      return text ? Response.json({choices:[{message:{content:'I feel better.'}}]})
        : Response.json({success:true,result:{text:'I feel better.'}});
    };
    const requests=await Promise.all(Array.from({length:scenario==='burst'?16:2},async()=>{
      const original=request('vi');const body=await original.arrayBuffer();
      return new Request(original.url,{method:'POST',headers:{...Object.fromEntries(original.headers),'content-length':String(body.byteLength)},body});
    }));
    const responses=await Promise.all(requests.map(async req=>{
      const response=await POST(req);return {...await result(response),retryAfter:response.headers.get('retry-after')};
    }));
    output={responses,asrPeak,textPeak};
  } else {
    delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    output = {response:await result(await POST(request()))};
  }
  console.log('__RESULT__'+JSON.stringify({...output,calls,logs}));
})().catch(error=>{console.error(error);process.exitCode=1;});
`;

type Result = { status: number; requestId: string; body: Record<string, unknown>; retryAfter?: string };
type HarnessResult = {
  response: Result;
  responses: Result[];
  busy: Result;
  first: Result;
  calls: Array<{ url: string; authorization?: string }>;
  asrPeak: number;
  textPeak: number;
  logs: Array<Record<string, unknown>>;
};

function run(scenario: string): HarnessResult {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", harness], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", CF_ROUTE_TEST_SCENARIO: scenario },
    encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("__RESULT__"));
  assert.ok(line, child.stdout);
  return JSON.parse(line.slice("__RESULT__".length)) as HarnessResult;
}

test("route rejects malformed input and invalid installation access before pool initialization", () => {
  const output = run("validation");
  assert.deepEqual(output.responses.map((response) => response.status), [415, 401, 400, 400, 403]);
  assert.equal(output.calls.length, 0);
  for (const response of output.responses) assert.equal(response.requestId, "route-test-request-id");
});

test("route flag OFF preserves success shape and ignores broken Redis/pool settings", () => {
  const { response, calls } = run("legacy");
  assert.equal(response.status, 200);
  assert.equal(response.requestId, "route-test-request-id");
  assert.equal(response.body.targetLanguage, "en");
  assert.equal(response.body.sourceText, "I feel better.");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"));
  assert.equal(calls[0].authorization, "Bearer legacy-secret-token");
});

test("route pool success preserves contract and skips text for English source", () => {
  const { response, calls } = run("pool");
  assert.equal(response.status, 200);
  assert.equal(response.body.englishText, "I feel better.");
  assert.equal(response.body.sourceLanguage, "en");
  assert.equal(response.body.targetLanguage, "en");
  assert.equal(response.body.textModel, undefined);
  assert.equal(response.body.requestId, "route-test-request-id");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/accounts/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"));
  assert.equal(calls[0].authorization, "Bearer dedicated-secret-token");
  assert.ok(!JSON.stringify(response).includes("audio-a"));
});

test("route pool configuration and Redis outages fail safely without legacy inference", () => {
  for (const scenario of ["configuration", "redis"]) {
    const { response, calls } = run(scenario);
    assert.equal(response.status, 503);
    assert.equal(response.requestId, "route-test-request-id");
    const text = JSON.stringify(response.body);
    assert.ok(text.includes('"error"'));
    for (const secret of ["secret-token", "private broken registry", "bbbbbbbb", "127.0.0.1"]) {
      assert.ok(!text.includes(secret), text);
    }
    assert.equal(calls.length, 0);
  }
});

test("route rejects exhausted pool concurrency without another provider call", () => {
  const output = run("exhaustion");
  assert.equal(output.busy.status, 429);
  assert.equal(output.first.status, 200);
  assert.equal(output.calls.length, 1);
  assert.equal(output.busy.requestId, "route-test-request-id");
});

test("a simultaneous burst queues before ASR and text without repeating ASR or exceeding permits", () => {
  const output = run("burst");
  assert.deepEqual(output.responses.map(response => response.status), Array(16).fill(200));
  assert.equal(output.calls.length, 32);
  assert.ok(output.asrPeak <= 2);
  assert.equal(output.textPeak, 1);
});

test("wrapped text capacity failures preserve Retry-After for clients", () => {
  const output = run("text-capacity");
  const busy = output.responses.find(response => response.status === 429);
  assert.ok(busy);
  assert.match(busy.retryAfter!, /^\d+$/);
  assert.ok(Number(busy.retryAfter) > 0);
  assert.equal((busy.body.error as { code: string }).code, "LLM_FAILED");
  assert.equal(output.responses.filter(response => response.status === 200).length, 1);
});

test("failure logs distinguish caller disconnect, backend deadline, Cloudflare HTTP and transport failures", () => {
  const cases = [
    { scenario: "client-upload", status: 499, source: "client", cause: "client_disconnect", stage: "upload", calls: 0, message: /bị hủy.*ngắt/ },
    { scenario: "client-inflight", status: 499, source: "client", cause: "client_disconnect", stage: "asr", calls: 1, message: /bị hủy.*ngắt/ },
    { scenario: "request-deadline", status: 504, source: "backend", cause: "request_deadline", stage: "upload", calls: 0, message: /Máy chủ.*hết thời gian/ },
    { scenario: "asr-429", status: 429, source: "cloudflare", upstream: 429, stage: "asr", calls: 1, message: /Cloudflare.*giới hạn/ },
    { scenario: "asr-503", status: 502, source: "cloudflare", upstream: 503, stage: "asr", calls: 1, message: /HTTP 503.*nhận diện giọng nói/ },
    { scenario: "text-503", status: 502, source: "cloudflare", upstream: 503, stage: "text_translation", calls: 2, message: /HTTP 503.*dịch văn bản/ },
    { scenario: "network", status: 502, source: "network", stage: "asr", calls: 1, message: /kết nối.*Cloudflare/ },
    { scenario: "unknown-abort", status: 499, source: "unknown", stage: "asr", calls: 1, message: /bị hủy trước khi hoàn tất/ },
  ];
  for (const expected of cases) {
    const output = run(`diagnostic-${expected.scenario}`);
    assert.equal(output.response.status, expected.status, expected.scenario);
    assert.match((output.response.body.error as { message: string }).message, expected.message, expected.scenario);
    assert.equal(output.calls.length, expected.calls, expected.scenario);
    const failure = output.logs.find(log => log.event === "cloudflare_audio_translation_failed");
    assert.ok(failure, expected.scenario);
    assert.equal(failure.failureSource, expected.source, expected.scenario);
    assert.equal(failure.abortCause, expected.cause, expected.scenario);
    assert.equal(failure.upstreamStatus, expected.upstream, expected.scenario);
    assert.equal(failure.requestStage, expected.stage, expected.scenario);
    assert.equal(failure.providerCallStarted, expected.calls > 0, expected.scenario);
    assert.equal(failure.providerAttempts, expected.calls, expected.scenario);
    assert.equal(failure.httpStatus, expected.status, expected.scenario);
    assert.ok(Number(failure.elapsedMs) >= 0, expected.scenario);
    assert.doesNotMatch(JSON.stringify(output.logs), /private|secret-token|bbbbbbbb|transcript/);
    assert.doesNotMatch(JSON.stringify(output.response.body), /failureSource|abortCause|upstreamStatus|private/);
    if (expected.calls) {
      const attempt = output.logs.find(log => log.event === "cloudflare_pool_attempt_completed" && log.safeReason);
      assert.equal(attempt?.failureSource, expected.source, expected.scenario);
      assert.equal(attempt?.upstreamStatus, expected.upstream, expected.scenario);
    }
  }
});
