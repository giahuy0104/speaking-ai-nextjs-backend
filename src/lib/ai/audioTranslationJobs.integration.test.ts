import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const harness = String.raw`
const Module=require('node:module'); const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='server-only')return {};return originalLoad.call(this,id,...args)};
const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');
Object.assign(process.env,{
 NODE_ENV:'test',PERSISTENCE_BACKEND:'local',DATABASE_URL:'',AUDIO_TRANSLATION_CACHE_ENABLED:'false',
 INSTALLATION_AUTH_REQUIRED:'true',INSTALLATION_AUTH_SECRET:'job-test-secret-more-than-32-characters',
 CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED:'true',CLOUDFLARE_POOL_STORE:'memory',CLOUDFLARE_POOL_MAX_WAIT_MS:'50',CLOUDFLARE_POOL_MAX_IN_FLIGHT:'4',
 CLOUDFLARE_POOL_MAX_QUEUED:'10',CLOUDFLARE_POOL_TEST_TOKEN:'test-token',CLOUDFLARE_ACCOUNT_ID:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 CLOUDFLARE_ACCOUNTS_JSON:JSON.stringify([{alias:'test-a',accountId:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',apiTokenEnv:'CLOUDFLARE_POOL_TEST_TOKEN',enabled:true,
 capabilities:{asr:['@cf/openai/whisper-large-v3-turbo'],text:['@cf/meta/llama-4-scout-17b-16e-instruct']},
 limits:{asr:{rpm:60000,burst:100,maxConcurrent:4},text:{rpm:60000,burst:100,maxConcurrent:1},accountMaxConcurrent:5}}]),
 AUDIO_TRANSLATION_JOBS_ENABLED:'true',AUDIO_TRANSLATION_JOBS_REDIS_URL:process.env.AUDIO_TRANSLATION_JOB_TEST_REDIS_URL,
 AUDIO_TRANSLATION_JOB_NAMESPACE:'audio-job-test-'+randomUUID(),AUDIO_TRANSLATION_JOB_STORAGE:'local'
});
delete process.env.AUDIO_TRANSLATION_CACHE_REDIS_URL;delete process.env.CLOUDFLARE_POOL_REDIS_URL;
if(process.env.AUDIO_TRANSLATION_JOB_TEST_QUOTA_REDIS_URL){process.env.CLOUDFLARE_POOL_STORE='redis';process.env.CLOUDFLARE_POOL_REDIS_URL=process.env.AUDIO_TRANSLATION_JOB_TEST_QUOTA_REDIS_URL;process.env.CLOUDFLARE_POOL_NAMESPACE='quota-job-test-'+randomUUID()}
delete process.env.CLOUDFLARE_WORKERS_AI_MODEL;delete process.env.CLOUDFLARE_TEXT_MODEL;
let calls={asr:0,text:0};let holdText=false;let unblock;let blocked;let textActive=0,textPeak=0;
globalThis.fetch=async(url)=>{if(String(url).includes('chat/completions')){calls.text++;textPeak=Math.max(textPeak,++textActive);if(holdText){holdText=false;blocked?.();await new Promise(r=>unblock=r)}textActive--;return Response.json({choices:[{message:{content:'I feel better.'}}]})}calls.asr++;return Response.json({success:true,result:{text:'I feel better.'}})};
(async()=>{
 await fs.mkdir(path.resolve('data'),{recursive:true});const root=await fs.mkdtemp(path.resolve('data/job-test-'));process.env.AUDIO_TRANSLATION_JOB_SHARED_DIRECTORY=root;
 const {registerInstallation}=require('./src/lib/installationAuth.ts');
 const a=await registerInstallation({clientId:'web_job_test_owner_a',platform:'web',installationSecret:'job-test-installation-secret-owner-000001'});
 const b=await registerInstallation({clientId:'web_job_test_owner_b',platform:'web',installationSecret:'job-test-installation-secret-owner-000002'});
 const {POST}=require('./src/app/api/audio/translate/route.ts');const {POST:SUBMIT}=require('./src/app/api/audio/jobs/route.ts');const {GET}=require('./src/app/api/audio/jobs/[jobId]/route.ts');
 const {jobQueue,closeJobQueue,capacityKeys}=require('./src/lib/ai/audioTranslationJobs.ts');
 const {startAudioTranslationWorker}=require('./src/lib/ai/audioTranslationWorker.ts');
 const req=(key='idem-job-test-0001',bytes='audio',prefer=false)=>{const f=new FormData();f.set('audio',new File([bytes],'speech.wav',{type:'audio/wav'}));f.set('sourceLanguage','vi');f.set('clientId',a.clientId);return new Request('http://localhost/api/audio/translate',{method:'POST',headers:{authorization:'Bearer '+a.accessToken,'idempotency-key':key,...(prefer?{prefer:'respond-async'}:{})},body:f})};
 const get=(id,token=a.accessToken)=>GET(new Request('http://localhost/api/audio/jobs/'+id,{headers:{authorization:'Bearer '+token}}),{params:Promise.resolve({jobId:id})});
 const first=await SUBMIT(req());const body=await first.json();if(first.status!==202)throw new Error('submit failed '+first.status);
 const duplicate=await SUBMIT(req());const again=await duplicate.json();
 const conflict=await SUBMIT(req('idem-job-test-0001','different'));
 const otherOwner=await get(body.jobId,b.accessToken);
 const {queue,raw}=await jobQueue();
 const cap=capacityKeys(a.clientId);await raw.zAdd(cap[0],{score:0,value:body.jobId});await raw.zAdd(cap[2],{score:0,value:body.jobId});
 process.env.AUDIO_TRANSLATION_JOB_MAX_PENDING='1';const full=await SUBMIT(req('idem-job-test-0002'));delete process.env.AUDIO_TRANSLATION_JOB_MAX_PENDING;
 const beforeWorkerCalls={...calls};
 const worker=await startAudioTranslationWorker();
 async function wait(id){for(let i=0;i<400;i++){const r=await get(id);const v=await r.json();if(v.status==='completed'||v.status==='failed')return v;await new Promise(r=>setTimeout(r,10))}throw new Error('job did not finish')}
 const completed=await wait(body.jobId);
 let textStarted;const textReady=new Promise(r=>textStarted=r);blocked=textStarted;holdText=true;
 const occupying=POST(req('occupying-request'));
 await textReady;
 const fallback=await POST(req('fallback-job-0001','second-audio',true));const fallbackBody=await fallback.json();
 const checkpointed=fallback.status===202?await queue.getJob(fallbackBody.jobId):null;
 unblock();await occupying;
 const beforeResume={...calls};const resumed=fallback.status===202?await wait(fallbackBody.jobId):null;
 const resumedCalls={asr:calls.asr-beforeResume.asr,text:calls.text-beforeResume.text};
 await worker.close();
 const uncertain=await SUBMIT(req('uncertain-job-001'));const uncertainBody=await uncertain.json();const uncertainJob=await queue.getJob(uncertainBody.jobId);
 await uncertainJob.updateData({...uncertainJob.data,phase:'asr_inflight'});const callsBeforeRecovery={...calls};
 const recoveryWorker=await startAudioTranslationWorker();const recovered=await wait(uncertainBody.jobId);await recoveryWorker.close();
 const output={first:first.status,duplicate:duplicate.status,sameJob:body.jobId===again.jobId,conflict:conflict.status,otherOwner:otherOwner.status,full:full.status,
 beforeWorkerCalls,completed:completed.status,fallback:fallback.status,checkpoint:!!checkpointed?.data.checkpoint,resumed:resumed?.status,resumedCalls,
 uncertain:recovered.status,noReplay:calls.asr===callsBeforeRecovery.asr&&calls.text===callsBeforeRecovery.text,textPeak};
 await queue.obliterate({force:true});await closeJobQueue();for(const name of await fs.readdir(root))await fs.unlink(path.join(root,name));await fs.rmdir(root);
 console.log('__RESULT__'+JSON.stringify(output));process.exit(0);
})().catch(()=>{console.error('Job integration harness failed');process.exit(1)});
`;

test("durable jobs enforce ownership, idempotency and bounds; fallback resumes ASR checkpoint without replay", {
  skip: process.env.AUDIO_TRANSLATION_JOB_TEST_ISOLATED !== "true" || !process.env.AUDIO_TRANSLATION_JOB_TEST_REDIS_URL,
}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", harness], {
    env: process.env, cwd: process.cwd(), encoding: "utf8", timeout: 45_000, windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split(/\r?\n/).find(l => l.startsWith("__RESULT__"));
  assert.ok(line, child.stdout);
  const result = JSON.parse(line.slice(10));
  assert.equal(result.first, 202); assert.equal(result.duplicate, 202); assert.equal(result.sameJob, true);
  assert.equal(result.conflict, 409); assert.equal(result.otherOwner, 404); assert.equal(result.full, 429);
  assert.deepEqual(result.beforeWorkerCalls, { asr: 0, text: 0 }); assert.equal(result.completed, "completed");
  assert.equal(result.fallback, 202); assert.equal(result.checkpoint, true); assert.equal(result.resumed, "completed");
  assert.equal(result.resumedCalls.asr, 0); assert.equal(result.uncertain, "failed"); assert.equal(result.noReplay, true);
  if (process.env.AUDIO_TRANSLATION_JOB_TEST_QUOTA_REDIS_URL) assert.equal(result.textPeak, 1);
});
