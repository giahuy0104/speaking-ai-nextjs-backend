# Railway Redis, pool, cache and worker rollout — 2026-10-29

Status: Redis, pool, shared cache and the worker are deployed and verified. **The web HTTP jobs feature remains disabled pending confirmation that the existing R2 bucket is private.** This is a deployment checkpoint, not acceptance of the full async HTTP rollout.

## Deployed services

All deployment actions used Chrome profile **HuaMei - A Huy**, project `backend-cloudflare`, production environment.

| Service | Railway service ID | Verified policy/state |
| --- | --- | --- |
| Web | `112c7f32-e31c-46b1-8349-ca19d2d58c1b` | Online; pool/cache enabled; HTTP jobs disabled |
| Worker | `5148acbc-910e-426d-9593-8ac1fe54da19` | Online; jobs consumer enabled; live expiring heartbeat |
| RedisQuota | `17ebc904-8ddc-450d-b32d-e5ccf16edbca` | Redis 7.4 Alpine; 128 MiB; noeviction; AOF everysec; `/data` volume |
| RedisCache | `c64cbfe1-763d-4644-a65b-8b7b243a28a3` | Redis 7.4 Alpine; 64 MiB; allkeys-lru; AOF and snapshots disabled |
| RedisJobs | `7e75afcc-7ef6-4ff0-b554-3d65dee29fff` | Redis 7.4 Alpine; 128 MiB; noeviction; AOF always; `/data` volume |

All three Redis services use private networking, password authentication, IPv4/IPv6 binding and Singapore. Their effective settings were read with authenticated PING/CONFIG GET. Quota/jobs AOF write status was `ok`. Worker PING succeeded against all three separate endpoints; a live worker heartbeat had approximately 14 seconds remaining on its 15-second TTL.

Web deployment: `7a62ecad-e0fc-4b82-8c72-1b9fe04cff72`, branch `can-bang-tai`, application commit `82ec0be428b876d489eac7a6473020be4a525fd9`.

Worker deployment: `dc3ff64d-a9fb-47f0-8a14-dc9c893effa6`, branch `codex/railway-worker-deploy`, commit `513ec8e3fc08aa20e40fcf72309ab351ce8aab40`.

The worker branch differs from the application commit only in root `Dockerfile` and `railway.json`: those files select the worker image/command and disable HTTP healthchecking. Railway initially built the web image despite a displayed custom worker Dockerfile path, causing `tsx` startup failure. Selecting the worker branch with a worker Dockerfile at the root resolved that failure. A fresh default-root image build and the full image smoke checks passed before this branch was deployed.

**Future application releases must also update the worker branch while preserving its two worker deployment files.** Pushing only `can-bang-tai` does not update the worker's application source. Do not merge the worker root deployment files back into the web branch.

## Configuration and code changes

- The existing two-account registry and its referenced tokens were installed on web; worker uses Railway variable references to the same configuration and credentials.
- The existing production Aura-2 TTS model and speaker were preserved. Its capability was added to the legacy account registry without changing quota limits.
- Production legacy account sharing and routing are enabled after a staged migration. All consumers use the same quota namespace and account identities.
- Quota, cache and jobs each reference a distinct Redis service. Web and worker share the jobs namespace and R2 configuration.
- Worker has a 45-second draining window. It has no public HTTP domain.
- Commit `82ec0be` bounds job R2 GET/DELETE to five seconds, including a stalled response body. Independent review verified cancellation closes the underlying sockets and does not change other storage callers or checkpoint/retry behavior.
- The pre-existing archive cron remains paused because its existing CRON_SECRET is shorter than the production minimum. No archive credential was rotated during this rollout.

## Verification completed

- Full integration suite: **426 passed, 0 failed, 0 skipped**, using disposable Redis/PostgreSQL; production credentials were not loaded by the test runner.
- ESLint and TypeScript: passed.
- Both Linux images built; Railway image smoke: **19/19 passed**, including worker startup, expiring heartbeat and SIGTERM cleanup. The worker branch's default root Dockerfile was separately built and passed the same smoke suite.
- Independent AI reviews covered pool/account migration, Redis policy, jobs/R2 timeouts, worker image mapping and the final acceptance gap.
- Both enabled Cloudflare accounts passed one small text inference each through the production Redis admission store; there were no inference retries.
- A new installation and an offline Microsoft David synthetic WAV were used for live checks. No human or child recording was used.
- Public synchronous audio translation returned the expected synthetic phrase on a cache miss; repeating it returned cache hit with ASR/translation timings both zero.
- A second fresh probe owner was used to force enqueue through application core in the worker console. Job `fe057e074abd7fefe024c5002c795e14831cd00b822216324c49dc2ada696a57` completed using R2 and actual worker ASR; checkpoint providerAttempts was **1**.
- R2 input was absent with HTTP 404 after completion, proving worker cleanup. The owned staging fixture was separately removed and absence verified.
- Web then returned a shared cache hit for the worker's owner/audio/language, with ASR/translation timings both zero.
- Both synthetic probe installations were revoked through their own credentials, and the temporary credential files were removed.
- Public readiness/health returned 200; unauthenticated admin/history APIs returned 401; admin page redirected with 307; same-origin preflight returned 204.

## Required remaining action

The existing R2 bucket accepts Head/Put/Get/Delete, but its Cloudflare REST managed/custom domain visibility endpoints return **403** with the available token. This does not establish whether the bucket is private. Attempting to create a fresh private jobs bucket with the existing S3 credentials also returned AccessDenied/403; no bucket was created.

Cloudflare is open in the same Chrome profile. The user must sign in so both managed public access and enabled custom domains can be inspected, or explicitly confirm the existing bucket is private. There is no need to create a broader API token merely for this inspection.

After private storage is confirmed:

1. Enable `AUDIO_TRANSLATION_JOBS_ENABLED=true` on web and deploy.
2. Confirm runtime validation, `/api/ready`, worker heartbeat and the final feature flags.
3. Test the public authenticated `/api/audio/jobs` flow: HTTP 202, same-idempotency replay, ownership protection, polling to completed, and worker-to-web cache hit using a fresh synthetic probe owner.
4. Update this checkpoint to record the final deployment ID and public jobs acceptance results.

The internal worker enqueue test above **does not substitute for the pending public HTTP 202-to-completed test**.

Evidence screenshot: `C:/Users/DELL/.codex/visualizations/2026/10/29/01a18554-646e-7a52-8cbc-6f13af1a7053/railway-redis-worker-online.jpg`.
