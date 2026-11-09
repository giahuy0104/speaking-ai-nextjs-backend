import { startAudioTranslationWorker } from "../src/lib/ai/audioTranslationWorker";
import { closeJobQueue } from "../src/lib/ai/audioTranslationJobs";

async function main() {
  const handle = await startAudioTranslationWorker();
  console.info(JSON.stringify({ event: "audio_translation_worker_ready" }));
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    await handle.close(); await closeJobQueue(); process.exit(0);
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}
main().catch(() => { console.error("Audio translation worker could not start. Check pool, jobs Redis and storage configuration."); process.exitCode = 1; });
