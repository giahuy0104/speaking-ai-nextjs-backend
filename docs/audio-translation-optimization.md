# Audio translation experiment — 2026-10-23

Status: local candidate only; semantic acceptance FAILED. Do not describe this
change as production-ready or as verified accurate speech translation.

The previous endpoint used Whisper Turbo with `task: translate`. OpenAI's
Whisper documentation explicitly says Turbo is not trained for translation:
https://github.com/openai/whisper#command-line-usage

The candidate uses Turbo transcription (beam size 2, VAD retained), followed by
Cloudflare text translation. English source skips the second call. It rejects
empty/low-confidence Vietnamese transcripts and obvious non-English output;
these guards are NOT proof that a transcript or translation is semantically
correct. Source-language timestamps/VTT are no longer returned as English
subtitles. `sourceText`, `textModel`, and per-stage `timings` are available.

Both stages share a bounded 20s deadline; the text call also keeps its own
configured deadline. Calls are not retried and identical audio is not cached
or coalesced, so benchmarks do not hide provider work on repeated files.

Real-provider comparison: three user audio recordings, two repetitions each,
alternating baseline/candidate ordering. No filename or reference transcript
was sent to either model. References came from the existing audio manifest.

| Audio | Baseline ms (two runs) | Candidate ms (two runs) | Candidate quality |
| --- | --- | --- | --- |
| 3-bo-oi-con-khoe-roi.mp3 | 3399 / 9978 | 1913 / 1669 | English but wrong meaning; ASR heard “Bố ơi vô vẻ rồi” |
| 2-con-nho-ngoai.wav | 4116 / 10757 | 1380 / 2098 | Rejected low-confidence ASR (422) |
| 003-con-dang-mac-ao.wav | 1296 / 881 | 1153 / 1215 | Rejected empty ASR (422) |

Neither approach passed the meaning checks on these samples. Lower rejection
latency must not be reported as a speed improvement for correct translations.
Extra probes with normalized 16kHz mono audio, loudness normalization, VAD
disabled, and beam size 5 did not recover the expected transcripts. A probe of
the legacy Cloudflare Whisper model exceeded its 20s deadline on the first file.
No new 100-user production run was performed: quality acceptance must pass first.

Reproduce (real provider usage, requires Cloudflare environment variables):

```powershell
node --env-file=.env.local --import tsx scripts/benchmark-audio-translation.ts AUDIO_DIR REPORT.json
```

Next: evaluate an ASR model suitable for these child recordings against an
independent held-out set. Do not insert filename-based answers or new aliases
derived solely from this benchmark to inflate quality scores. After meaning
checks pass, benchmark unique recordings under representative concurrency and
inspect upstream rate limits for BOTH the ASR and text models before rollout.
