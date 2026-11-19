/**
 * One synthesis per sentence per process for deferred zh/ja/ko/fr speech.
 *
 * The conversation pipeline starts synthesis as soon as the translation exists
 * and returns a URL; the app's audio request (usually < 1 s later) joins the same
 * promise instead of paying for a second call. A settled result stays a short
 * while so a late request still gets the bytes before the durable cache has them.
 */

export type TargetSpeechJob = Promise<ArrayBuffer>;

export type TargetSpeechCoordinatorOptions = {
  synthesize: (text: string, language: string) => Promise<ArrayBuffer>;
  /** Persists the clip for later requests; failures are reported, never thrown to listeners. */
  save: (text: string, language: string, audio: ArrayBuffer) => Promise<unknown>;
  onSaveError?: (error: unknown) => void;
  retainMs?: number;
  /** How long a kept failure is kept, so repeated requests get it at once instead of a new synthesis. */
  failureRetainMs?: number;
  /**
   * Whether a failure is kept at all (default: every failure). Only a refusal that a
   * retry would hit again (provider busy, quota) is worth keeping; a timeout or a
   * network error should be retried by the next request.
   */
  shouldRetainFailure?: (error: unknown) => boolean;
  maxEntries?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
};

const DEFAULT_RETAIN_MS = 60_000;
// The app downloads a URL twice and Nginx may retry: without this, each failed turn
// paid for 2-3 syntheses while the provider was already refusing (429). Short, so a
// sentence is tried again soon after the provider recovers.
const DEFAULT_FAILURE_RETAIN_MS = 10_000;
// A burst of distinct sentences must not grow memory without bound (a clip is ~10-50 KB).
const DEFAULT_MAX_ENTRIES = 500;

export function createTargetSpeechCoordinator(options: TargetSpeechCoordinatorOptions) {
  const jobs = new Map<string, TargetSpeechJob>();
  const retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;
  const failureRetainMs = options.failureRetainMs ?? DEFAULT_FAILURE_RETAIN_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const setTimer = options.setTimer ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });

  const keyFor = (text: string, language: string) => `${language}\n${text}`;

  function forget(key: string, job: TargetSpeechJob) {
    if (jobs.get(key) === job) jobs.delete(key);
  }

  return {
    /** The running or recently finished job for this sentence, if any. */
    peek(text: string, language: string): TargetSpeechJob | undefined {
      return jobs.get(keyFor(text, language));
    },

    /** Joins the running job or starts one. The caller decides whether to await it. */
    start(text: string, language: string): TargetSpeechJob {
      const key = keyFor(text, language);
      const existing = jobs.get(key);
      if (existing) return existing;
      if (jobs.size >= maxEntries) {
        // Oldest first: Map keeps insertion order.
        const oldest = jobs.keys().next().value;
        if (oldest !== undefined) jobs.delete(oldest);
      }
      const job = options.synthesize(text, language).then(audio => {
        options.save(text, language, audio).catch(error => options.onSaveError?.(error));
        return audio;
      });
      jobs.set(key, job);
      // A success is kept briefly for a late request. A refusal is kept so the app's
      // repeated downloads fail fast (to its device voice) instead of asking a provider
      // that is already refusing; any other failure is dropped so the next request retries.
      job.then(
        () => setTimer(() => forget(key, job), retainMs),
        error => {
          if (options.shouldRetainFailure && !options.shouldRetainFailure(error)) forget(key, job);
          else setTimer(() => forget(key, job), failureRetainMs);
        },
      );
      return job;
    },

    size() {
      return jobs.size;
    },
  };
}
