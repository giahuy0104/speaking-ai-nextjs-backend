This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## HuaMei ASR with Cloudflare text and TTS

Configure the HuaMei Child Speech API for Vietnamese child-speech recognition.
The API key stays server-side:

```env
HUAMEI_CHILD_SPEECH_API_URL=https://huamei-child-speech-api-415112188289.us-central1.run.app/transcribe
HUAMEI_CHILD_SPEECH_API_KEY=your-huamei-api-key
HUAMEI_CHILD_SPEECH_MODEL=whisper-tiny-children-v2
HUAMEI_CHILD_SPEECH_TIMEOUT_MS=30000
HUAMEI_CHILD_SPEECH_MAX_BYTES=26214400

CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
CLOUDFLARE_WORKERS_AI_API_TOKEN=your-workers-ai-token
CLOUDFLARE_TEXT_MODEL=@cf/meta/llama-4-scout-17b-16e-instruct
CLOUDFLARE_TEXT_TIMEOUT_MS=2500
CLOUDFLARE_TTS_MODEL=@cf/deepgram/aura-1
CLOUDFLARE_TTS_SPEAKER=luna
CLOUDFLARE_TTS_TIMEOUT_MS=20000
```

The Flutter API contract does not change. `/api/conversation` applies this
order:

1. HuaMei Child Speech ASR for uploaded Vietnamese audio;
2. reviewed exact rule or V1 text cache;
3. Cloudflare multilingual text model with the faithful V1 prompt;
4. the audio cache, then Cloudflare Aura TTS.

Vietnamese batch ASR does not fall back to Cloudflare. A HuaMei API failure
returns the existing retryable ASR error. Text translation and English TTS
continue to use Cloudflare until equivalent replacement endpoints are
available. The legacy realtime-session endpoint returns HTTP 410 and cannot
create an external realtime session.

`POST /api/audio/translate` remains an independent compatibility endpoint for
direct audio translation. It is not used by the Flutter conversation pipeline
because direct audio translation would bypass the Vietnamese exact-rule check.

The compatibility endpoint accepts `multipart/form-data`:

- `audio` (required): AAC, FLAC, M4A, MP3, MP4, OGG, WAV or WebM file;
- `sourceLanguage` (optional): ISO language code, defaults to `vi`.

The API calls Cloudflare with `task: "translate"` and returns an English result:

```json
{
  "sourceLanguage": "vi",
  "targetLanguage": "en",
  "englishText": "I would like some water.",
  "wordCount": 5,
  "model": "@cf/openai/whisper-large-v3-turbo"
}
```

## Admin dashboard

Open [http://localhost:3000/admin](http://localhost:3000/admin) to:

- filter conversation history by device and review status;
- label the current Android device and child profile;
- approve, reject, or correct an English sentence;
- play the authenticated Cloudinary recording captured from each audio turn;
- save approved corrections as a client-scoped rule and warm its audio cache;
- request an AI review only when needed, reusing the saved result afterward.

Admin access requires a username and password in every environment. Copy
`.env.example` to `.env.local`, set `ADMIN_USERNAME` and a strong,
unique `ADMIN_PASSWORD`, then restart the server and sign in at `/admin/login`.
The signed, HTTP-only session lasts 12 hours. Changing either environment value
invalidates every existing admin session.

User recordings are uploaded only after the conversation response has been sent,
so this archival step does not delay playback. Configure `CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. The assets use Cloudinary's
authenticated delivery type and the dashboard streams them through an
admin-protected backend route.

## Storage modes

Local development remains the default, so the current emulator and existing
JSON/audio files continue to work without extra services:

```env
PERSISTENCE_BACKEND=local
AUDIO_STORAGE_BACKEND=local
```

For the current MVP, PostgreSQL can persist both records and generated English
audio across deploys and backend replicas. When `DATABASE_URL` is present and
`AUDIO_STORAGE_BACKEND` is omitted, this mode is selected automatically:

```env
PERSISTENCE_BACKEND=postgres
DATABASE_URL=postgresql://...
AUDIO_STORAGE_BACKEND=postgres
CRON_SECRET=use-a-long-random-secret
```

At larger audio volume, keep PostgreSQL for records and use Vercel Blob for
generated English audio:

```env
PERSISTENCE_BACKEND=postgres
DATABASE_URL=postgresql://...
AUDIO_STORAGE_BACKEND=vercel-blob
GENERATED_AUDIO_BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
CRON_SECRET=use-a-long-random-secret
```

The Blob store is public because it only contains generated English TTS. The
child's uploaded voice chunks are transient and are stored in PostgreSQL with a
short TTL; they are never published as Blob URLs.

Cloudflare R2 is also supported for the immutable shared TTS cache:

```env
PERSISTENCE_BACKEND=postgres
DATABASE_URL=postgresql://...
AUDIO_STORAGE_BACKEND=r2
CLOUDFLARE_R2_ACCOUNT_ID=...
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_R2_BUCKET=...
CLOUDFLARE_R2_PUBLIC_BASE_URL=https://audio.example.com
AUDIO_WARMUP_RULE_LIMIT=10000
AUDIO_WARMUP_CONCURRENCY=4
```

Warm-up is capped at 10,000 rules and covers the complete reviewed corpus by
default. It generates only missing audio; all other rules are synthesized once
on first use. Streaming TTS uses a
separate cache-fill response branch, so stopping playback does not cancel the
durable R2/PostgreSQL write.

Before enabling managed storage, run:

```bash
npm run storage:migrate:dry-run
npm run storage:migrate
npm run storage:check
```

Migration first creates a local backup under `backups/`, copies data without
deleting local files, and is safe to repeat. To prepare a local rollback
snapshot, run `npm run storage:rollback`. Applying it to the live local folders
requires the explicit `npm run storage:rollback:apply` command.

The endpoint `GET /api/admin/storage-health` checks the selected storage
providers. Expired upload sessions are cleaned opportunistically and hourly by
the Vercel cron configured in `vercel.json`.

Upload defaults are 1 MiB per chunk, 16 MiB per session, 1,000 chunks and a
15-minute unfinished-session TTL. They can be adjusted through the environment
variables documented in `.env.example`.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
