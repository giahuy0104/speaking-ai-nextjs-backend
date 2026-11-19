/**
 * Uncompressed WAV for streamed speech: a 44-byte RIFF header in front of mono
 * signed 16-bit little-endian PCM. No encoding, so audio leaves the server as
 * soon as it arrives; the cost is ~8x the bytes of a 48 kbps MP3.
 */

export const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
const CHANNELS = 1;
// Size fields of a WAV whose length is not known yet (still being generated).
// Players read until the connection closes.
const UNKNOWN_SIZE = 0xffffffff;
const RIFF_SIZE_OFFSET = 4;
const DATA_TAG_OFFSET = 36;
const DATA_SIZE_OFFSET = 40;

const asciiAt = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

export function wavHeader(sampleRate: number, dataBytes?: number): Uint8Array {
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(RIFF_SIZE_OFFSET, dataBytes === undefined ? UNKNOWN_SIZE : 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  write(DATA_TAG_OFFSET, "data");
  view.setUint32(DATA_SIZE_OFFSET, dataBytes === undefined ? UNKNOWN_SIZE : dataBytes, true);
  return header;
}

/**
 * Wraps a PCM stream as a streaming WAV. The header leaves together with the
 * first PCM chunk, never alone: until real audio exists nothing is emitted, so
 * the caller can still fall back to another source.
 */
export function pcmStreamToWav(pcm: ReadableStream<Uint8Array>, sampleRate: number): ReadableStream<Uint8Array> {
  const reader = pcm.getReader();
  let headerSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value.byteLength === 0) continue;
        if (headerSent) {
          controller.enqueue(value);
          return;
        }
        headerSent = true;
        const first = new Uint8Array(WAV_HEADER_BYTES + value.byteLength);
        first.set(wavHeader(sampleRate), 0);
        first.set(value, WAV_HEADER_BYTES);
        controller.enqueue(first);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

export function isWav(audio: ArrayBuffer | Uint8Array): boolean {
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  return bytes.byteLength >= 12 && asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WAVE";
}

/**
 * A finished streaming WAV with its real sizes, for the cache and for
 * Content-Length responses. Any other audio is returned unchanged.
 */
export function withWavSizes(audio: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(audio);
  if (bytes.byteLength < WAV_HEADER_BYTES || !isWav(bytes) || asciiAt(bytes, DATA_TAG_OFFSET, 4) !== "data") return audio;
  if (new DataView(audio).getUint32(DATA_SIZE_OFFSET, true) !== UNKNOWN_SIZE) return audio;
  const sized = audio.slice(0);
  const view = new DataView(sized);
  view.setUint32(RIFF_SIZE_OFFSET, sized.byteLength - 8, true);
  view.setUint32(DATA_SIZE_OFFSET, sized.byteLength - WAV_HEADER_BYTES, true);
  return sized;
}
