# Cloudinary TTS cache rollout

Required environment: `DATABASE_URL`, `AUDIO_STORAGE_BACKEND=cloudinary`,
`CLOUDINARY_TTS_CLOUD_NAME`, `CLOUDINARY_TTS_API_KEY`, `CLOUDINARY_TTS_API_SECRET`.
These credentials are independent of `CLOUDINARY_*` used for private user audio.
TTS assets are public MP3 files in `speaking-ai/tts/`; do not put user recordings there.

1. Backfill the production database before switching the reader:
   `node --import tsx scripts/migrate-tts-to-cloudinary.ts --credentials <private-file>`
   defaults to dry-run; add `--apply` to upload. Optional `--limit 1` for a canary.
   Set `TTS_MIGRATION_DATABASE_URL` to choose the source database explicitly.
2. Every upload is downloaded and checked with SHA-256 before its Cloudinary URL
   is indexed in `generated_audio`. No speech synthesis is called. Original bytes
   remain in the database by default, so the previous deployment still works.
3. Deploy the new code and environment. Conversation audio cache misses stream
   immediately; the cloned response is uploaded in the existing background cache
   fill. Historical `/api/audio/cache/<file>` URLs redirect to Cloudinary.
   Unmigrated rows still play from PostgreSQL, avoiding regeneration during rollout.
4. Check playback, then rerun the migration with `--apply --release-db-bytes`.
   This re-verifies each file before clearing its Base64 payload. Metadata rows and
   filenames remain; `app_records` history links require no rewriting. Old readers
   that cannot redirect to Cloudinary must no longer be running before this step.
5. Repeat with each older database if it contains additional audio. Upload IDs are
   deterministic and never overwrite existing assets; a different payload at the
   same ID fails checksum verification rather than silently replacing audio.

Migration is resumable. `--release-db-bytes` frees live payload storage; PostgreSQL
may keep allocated relation space for reuse until normal vacuum/maintenance.
Do not reset the database or regenerate the warmup corpus to perform this migration.
