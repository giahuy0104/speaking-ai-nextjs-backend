import { findSpeechBounds } from "./trimRecordedAudio";

/** Optional, conservative PCM16 WAV optimization. Unsupported formats and
 * uncertain speech pass through byte-for-byte. Never changes speech samples. */
export function trimPcmWav(input: ArrayBuffer): { bytes: ArrayBuffer; savedBytes: number } {
  const unchanged = { bytes: input, savedBytes: 0 };
  const bytes = new Uint8Array(input); const view = new DataView(input);
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length < 44 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) return unchanged;
  let format = -1; let data = -1; let length = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    if (size > bytes.length - offset - 8) return unchanged;
    if (ascii(offset, 4) === "fmt " && size >= 16) { if (format >= 0) return unchanged; format = offset + 8; }
    if (ascii(offset, 4) === "data") { if (data >= 0) return unchanged; data = offset + 8; length = size; }
    offset += 8 + size + (size % 2);
  }
  if (format < 0 || data < 0 || view.getUint16(format, true) !== 1 || view.getUint16(format + 14, true) !== 16) return unchanged;
  const channels = view.getUint16(format + 2, true); const rate = view.getUint32(format + 4, true);
  const align = channels * 2;
  if (![1, 2].includes(channels) || rate < 8000 || rate > 48000 || view.getUint16(format + 12, true) !== align || length % align) return unchanged;
  const samples = length / align;
  if (samples > rate * 60) return unchanged;
  const decoded = Array.from({ length: channels }, (_, channel) => {
    const values = new Float32Array(samples);
    for (let i = 0; i < samples; i++) values[i] = view.getInt16(data + i * align + channel * 2, true) / 32768;
    return values;
  });
  const bounds = findSpeechBounds(decoded, rate);
  if (!bounds || (samples - bounds.endSample + bounds.startSample) / rate < .2) return unchanged;
  const retainedBytes = (bounds.endSample - bounds.startSample) * align;
  const output = new ArrayBuffer(44 + retainedBytes); const target = new Uint8Array(output); const out = new DataView(output);
  target.set(bytes.subarray(0, 12)); out.setUint32(4, 36 + retainedBytes, true);
  target.set([102, 109, 116, 32], 12); out.setUint32(16, 16, true); target.set(bytes.subarray(format, format + 16), 20);
  target.set([100, 97, 116, 97], 36); out.setUint32(40, retainedBytes, true);
  target.set(bytes.subarray(data + bounds.startSample * align, data + bounds.endSample * align), 44);
  return { bytes: output, savedBytes: input.byteLength - output.byteLength };
}
