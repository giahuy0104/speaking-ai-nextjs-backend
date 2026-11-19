import { WAV_HEADER_BYTES } from "./wav";

/**
 * Apple's Core Audio Format, used only to re-wrap an already-produced live WAV
 * stream (see wav.ts) for an iOS client that opts in with `?format=caf`.
 *
 * Unlike WAV, CAF's 'data' chunk has an officially documented value for
 * "length not known yet": mChunkSize = -1 means "read to end of file". A
 * growing WAV response (RIFF/data sizes left at a placeholder, since the
 * final length is not known until synthesis ends) is exactly what makes
 * AVPlayer on iOS refuse the stream with AVFoundationErrorDomain -11850
 * ("Operation Stopped" / server incorrectly configured) — WAV has no
 * equivalent convention. Android/ExoPlayer has no CAF demuxer at all, so this
 * must never change what Android or the cache receive: see
 * rewrapWavStreamAsCaf below, which only transforms the bytes of one
 * response, never the shared synthesis/broadcast/cache pipeline in wav.ts.
 *
 * https://developer.apple.com/library/archive/documentation/MusicAudio/Reference/CAFSpec/CAF_spec/CAF_spec.html
 */

const FILE_HEADER_BYTES = 8;
const DESC_CHUNK_BYTES = 12 + 32; // chunk header (tag + 64-bit size) + CAFAudioFormat body
const DATA_CHUNK_HEADER_BYTES = 12; // tag + 64-bit size, before mEditCount
const EDIT_COUNT_BYTES = 4;
export const CAF_HEADER_BYTES = FILE_HEADER_BYTES + DESC_CHUNK_BYTES + DATA_CHUNK_HEADER_BYTES + EDIT_COUNT_BYTES; // 68
const BYTES_PER_SAMPLE = 2;
const CHANNELS = 1;
// kCAFLinearPCMFormatFlagIsFloat = 0 (signed int), kCAFLinearPCMFormatFlagIsLittleEndian = 1 << 1.
const LPCM_SIGNED_LITTLE_ENDIAN_FLAGS = 0x2;
// BigInt(-1), not a `-1n` literal: the project's TS target (ES2017) cannot
// emit BigInt literal syntax, even though Node fully supports the BigInt
// values themselves.
const UNKNOWN_DATA_SIZE = BigInt(-1);
// Offset of the 'data' chunk's 64-bit mChunkSize field (right after its 4-byte tag).
const DATA_CHUNK_SIZE_OFFSET = FILE_HEADER_BYTES + DESC_CHUNK_BYTES + 4;

function write4CC(view: DataView, offset: number, fourCC: string) {
  for (let i = 0; i < 4; i += 1) view.setUint8(offset + i, fourCC.charCodeAt(i));
}

/**
 * dataBytes is always omitted here: every caller streams live, and a
 * finished CAF clip is never produced (the cache stays WAV; see module doc).
 * All multi-byte fields are big-endian, per the CAF spec, except the audio
 * samples themselves (little-endian, declared by the format flags below).
 */
export function cafHeader(sampleRate: number): Uint8Array {
  const header = new Uint8Array(CAF_HEADER_BYTES);
  const view = new DataView(header.buffer);
  let offset = 0;

  write4CC(view, offset, "caff");
  offset += 4;
  view.setUint16(offset, 1, false); // mFileVersion
  offset += 2;
  view.setUint16(offset, 0, false); // mFileFlags
  offset += 2;

  write4CC(view, offset, "desc");
  offset += 4;
  view.setBigInt64(offset, BigInt(DESC_CHUNK_BYTES - 12), false); // 32-byte CAFAudioFormat body
  offset += 8;
  view.setFloat64(offset, sampleRate, false); // mSampleRate
  offset += 8;
  write4CC(view, offset, "lpcm"); // mFormatID
  offset += 4;
  view.setUint32(offset, LPCM_SIGNED_LITTLE_ENDIAN_FLAGS, false); // mFormatFlags
  offset += 4;
  view.setUint32(offset, CHANNELS * BYTES_PER_SAMPLE, false); // mBytesPerPacket
  offset += 4;
  view.setUint32(offset, 1, false); // mFramesPerPacket (required for LPCM)
  offset += 4;
  view.setUint32(offset, CHANNELS, false); // mChannelsPerFrame
  offset += 4;
  view.setUint32(offset, BYTES_PER_SAMPLE * 8, false); // mBitsPerChannel
  offset += 4;

  write4CC(view, offset, "data");
  offset += 4;
  view.setBigInt64(offset, UNKNOWN_DATA_SIZE, false); // streaming: read to EOF
  offset += 8;
  view.setUint32(offset, 0, false); // mEditCount
  offset += 4;

  return header;
}

/**
 * Re-wraps an already-live WAV stream (see wav.ts's pcmStreamToWav) as CAF,
 * for one response only. Strips the 44-byte WAV header from the front of the
 * stream (reading its sample rate out first) and replaces it with a CAF
 * header; every PCM byte after that passes through completely unchanged,
 * since the two containers wrap the exact same mono 16-bit little-endian PCM.
 */
export function rewrapWavStreamAsCaf(wav: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = wav.getReader();
  let pending = new Uint8Array(0);
  let headerRewritten = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value.byteLength === 0) continue;
        if (headerRewritten) {
          controller.enqueue(value);
          return;
        }
        const combined = new Uint8Array(pending.byteLength + value.byteLength);
        combined.set(pending, 0);
        combined.set(value, pending.byteLength);
        if (combined.byteLength < WAV_HEADER_BYTES) {
          // The WAV header always leaves with its first PCM chunk in one
          // piece (see pcmStreamToWav), so this only guards a stream that
          // somehow split across reads smaller than the header itself.
          pending = combined;
          continue;
        }
        const sampleRate = new DataView(combined.buffer, combined.byteOffset, combined.byteLength).getUint32(24, true);
        const pcmSoFar = combined.subarray(WAV_HEADER_BYTES);
        const out = new Uint8Array(CAF_HEADER_BYTES + pcmSoFar.byteLength);
        out.set(cafHeader(sampleRate), 0);
        out.set(pcmSoFar, CAF_HEADER_BYTES);
        headerRewritten = true;
        controller.enqueue(out);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}
