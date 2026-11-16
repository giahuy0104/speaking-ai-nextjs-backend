import type { Mp3Encoder } from "@breezystack/lamejs";

// The package's CommonJS build is a browser IIFE that exports nothing, so a
// static import breaks under CommonJS (tsx tests); import() takes the ESM build.
let encoderClass: Promise<typeof Mp3Encoder> | undefined;
function loadMp3Encoder() {
  encoderClass ??= import("@breezystack/lamejs").then(module => module.Mp3Encoder);
  return encoderClass;
}

/**
 * Encodes a mono signed 16-bit little-endian PCM stream to MP3 as it arrives,
 * so a listener can start playing before the speech is finished. MP3 frames
 * are self-delimiting: any prefix of the output is playable.
 */

// Speech at 24 kHz mono: ~6 KB/s, close to the clips /audio/speech returns.
const DEFAULT_KBPS = 48;
// One MPEG-2 layer III frame at 24 kHz holds 576 samples; feed whole frames.
const SAMPLES_PER_BLOCK = 576 * 4;

export function encodePcmStreamToMp3(
  pcm: ReadableStream<Uint8Array>,
  sampleRate: number,
  kbps = DEFAULT_KBPS,
): ReadableStream<Uint8Array> {
  let encoder: Mp3Encoder;
  const reader = pcm.getReader();
  let pending = new Int16Array(0);

  const encode = (samples: Int16Array) => toOwnedBytes(encoder.encodeBuffer(samples));

  return new ReadableStream<Uint8Array>({
    async start() {
      encoder = new (await loadMp3Encoder())(1, sampleRate, kbps);
    },
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = pending.length > 0 ? encode(pending) : undefined;
          if (tail) controller.enqueue(tail);
          const last = toOwnedBytes(encoder.flush());
          if (last) controller.enqueue(last);
          controller.close();
          return;
        }
        pending = appendSamples(pending, value);
        const whole = pending.length - (pending.length % SAMPLES_PER_BLOCK);
        if (whole === 0) continue;
        const mp3 = encode(pending.subarray(0, whole));
        pending = pending.slice(whole);
        if (mp3) {
          controller.enqueue(mp3);
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

/**
 * lamejs returns an Int8Array (despite its types) that may share its internal
 * buffer; a Response body only accepts Uint8Array chunks, so copy into one.
 */
function toOwnedBytes(out: ArrayBufferView) {
  return out.byteLength > 0 ? new Uint8Array(out.buffer, out.byteOffset, out.byteLength).slice() : undefined;
}

/** Upstream chunks hold whole samples (see streamSpeechWithDeepInfra). */
function appendSamples(head: Int16Array, bytes: Uint8Array) {
  const count = bytes.byteLength >> 1;
  const joined = new Int16Array(head.length + count);
  joined.set(head, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  for (let i = 0; i < count; i++) joined[head.length + i] = view.getInt16(i * 2, true);
  return joined;
}
