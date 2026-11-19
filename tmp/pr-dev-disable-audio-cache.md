feat(audio): AUDIO_CACHE_DISABLED turns the audio cache off for every client on dev

## Summary
`LOAD_TEST_BYPASS_AUDIO_CACHE` only skipped the cache for `web_k6_` load-test installations; real phones still read and wrote `generated_audio` and the English text cache. The new dev-only flag `AUDIO_CACHE_DISABLED=true` sends every installation down the same uncached path, while conversation history is still saved.

- `/api/audio/stream` bypasses the cache for every URL while the flag is on, signed or not (offline intents, old app builds).
- iOS (`?format=caf` or a bounded `Range`) gets the finished uncached English audio with `Content-Length` and byte ranges instead of a live stream of unknown length (AVPlayer -11850). The probe and the download share one synthesis, kept in memory for 20 s (`src/lib/ai/uncachedEnglishSpeech.ts`).
- The job worker skips the translation and text caches too.
- Cache warm-up is skipped and returns 202 `skipped: audio_cache_disabled`. The history claim and the learning migration still run.
- Startup refuses the flag unless `AUDIO_TARGET_TTS_DEFERRED=true`; otherwise uncached zh/ja/ko/fr turns would get no audio URL.
- With the flag unset, production behaviour does not change. The only exception is a load-test request to `/api/audio/stream` with `format=caf` or a Range: it now gets the finished file instead of a live stream.

## Test plan
- [x] `npm test`: 730 passed, 0 failed (4 skipped)
- [x] `tsc --noEmit` and `eslint` on the changed files
- [x] New: `src/app/api/audio/stream/route.test.ts` covers the iOS probe and download (206/200, one synthesis), the plain player and an unsigned URL
- [x] New cases in `loadTestPersistence.test.ts`, `loadTestCacheBypass.test.ts` and `runtime-config.test.mjs`
- [ ] After the dev deploy: set `AUDIO_CACHE_DISABLED=true` in `/opt/homi/backend-dev/.env.local`, restart, and check the logs for `audioCacheBypassed: true`, `X-Audio-Cache: bypass` and no new `generated_audio` rows
- [ ] Not covered by tests: long English sentences (WAV, `withWavSizes`) and the warm-up skip
