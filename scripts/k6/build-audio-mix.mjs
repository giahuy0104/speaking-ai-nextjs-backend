#!/usr/bin/env node
// Builds the audio mix that scripts/k6/audio-closed-loop.js sends.
//
// Reads PCM WAV recordings from a folder (recursively) and writes one JSON file:
//   [{ audioName, sourceLanguage, durationMs, audioBase64 }, ...]
//
// Usage:
//   node scripts/k6/build-audio-mix.mjs --src "<folder with .wav>" [options]
//
// Options:
//   --out <file>     output file (default scripts/k6/data/audio-mix.json, git-ignored)
//   --count <n>      clips in the mix (default 40)
//   --mode real      use recordings as they are, sampled evenly across their lengths (default)
//   --mode concat    join several recordings (0.3s silence between) into longer clips
//   --min <s>        shortest clip in seconds (default 0 for real, 6 for concat)
//   --max <s>        longest clip in seconds (default 999 for real, 12 for concat)
//   --language <c>   sourceLanguage sent with every clip (default vi)
//   --seed <n>       random seed, so the same command builds the same mix (default 1)
//
// The output holds real voice recordings. Keep it out of git.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SILENCE_BETWEEN_CLIPS_S = 0.3;
const WAV_HEADER_BYTES = 44;
const PCM_FORMAT = 1;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return args;
}

function listWavFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listWavFiles(path);
    return entry.name.toLowerCase().endsWith(".wav") ? [path] : [];
  });
}

/** Walks the RIFF chunks; returns null for anything that is not plain PCM WAV. */
function readWav(path) {
  const buffer = readFileSync(path);
  if (buffer.length < WAV_HEADER_BYTES || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let format;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = { encoding: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4), bitsPerSample: buffer.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format || format.encoding !== PCM_FORMAT) return null;
      const pcm = buffer.subarray(body, Math.min(buffer.length, body + size));
      const bytesPerSecond = format.sampleRate * format.channels * format.bitsPerSample / 8;
      return { path, buffer, pcm, format, durationS: pcm.length / bytesPerSecond };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function wavFromPcm(pcm, format) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const blockAlign = format.channels * format.bitsPerSample / 8;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(PCM_FORMAT, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Small seeded generator: the same seed always builds the same mix. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Evenly spaced picks from the length-sorted list keep the original spread of lengths. */
function pickAcrossLengths(recordings, count) {
  const sorted = [...recordings].sort((a, b) => a.durationS - b.durationS);
  if (sorted.length <= count) return sorted;
  return Array.from({ length: count }, (_, i) => sorted[Math.floor((i + 0.5) * sorted.length / count)]);
}

function buildRealMix(recordings, { count, minS, maxS, language }) {
  const inRange = recordings.filter(r => r.durationS >= minS && r.durationS <= maxS);
  if (!inRange.length) throw new Error(`No recording is between ${minS}s and ${maxS}s long. Try --mode concat.`);
  return pickAcrossLengths(inRange, count).map(r => ({
    audioName: basename(r.path), sourceLanguage: language, durationMs: Math.round(r.durationS * 1000),
    audioBase64: r.buffer.toString("base64"),
  }));
}

function buildConcatMix(recordings, { count, minS, maxS, language, random }) {
  const formatKey = r => `${r.format.sampleRate}/${r.format.channels}/${r.format.bitsPerSample}`;
  const groups = Map.groupBy(recordings, formatKey);
  const pool = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  const { format } = pool[0];
  const bytesPerSecond = format.sampleRate * format.channels * format.bitsPerSample / 8;
  const blockAlign = format.channels * format.bitsPerSample / 8;
  const silence = Buffer.alloc(Math.round(SILENCE_BETWEEN_CLIPS_S * bytesPerSecond / blockAlign) * blockAlign);
  return Array.from({ length: count }, (_, index) => {
    const targetS = minS + random() * (maxS - minS);
    const parts = [];
    let durationS = 0;
    while (durationS < targetS) {
      const next = pool[Math.floor(random() * pool.length)];
      const addedS = next.durationS + (parts.length ? SILENCE_BETWEEN_CLIPS_S : 0);
      if (parts.length && durationS + addedS > maxS) break;
      if (parts.length) parts.push(silence);
      parts.push(next.pcm);
      durationS += addedS;
    }
    const wav = wavFromPcm(Buffer.concat(parts), format);
    return { audioName: `concat-${String(index + 1).padStart(3, "0")}.wav`, sourceLanguage: language,
      durationMs: Math.round(durationS * 1000), audioBase64: wav.toString("base64") };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.src) {
    console.error('Usage: node scripts/k6/build-audio-mix.mjs --src "<folder with .wav>" [--mode real|concat] [--count 40] [--min s] [--max s] [--out file]');
    process.exit(1);
  }
  const mode = args.mode || "real";
  if (mode !== "real" && mode !== "concat") throw new Error("--mode must be real or concat");
  const options = {
    count: Math.max(1, Number(args.count) || 40),
    minS: args.min !== undefined ? Number(args.min) : mode === "concat" ? 6 : 0,
    maxS: args.max !== undefined ? Number(args.max) : mode === "concat" ? 12 : 999,
    language: args.language || "vi",
    random: createRandom(Number(args.seed) || 1),
  };
  if (!(options.minS >= 0) || !(options.maxS > options.minS)) throw new Error("--min and --max must be seconds with min < max");
  const out = args.out || join(dirname(fileURLToPath(import.meta.url)), "data", "audio-mix.json");

  const files = listWavFiles(args.src);
  const recordings = files.map(readWav).filter(Boolean);
  if (!recordings.length) throw new Error(`No PCM WAV recordings found under ${args.src}`);
  const mix = mode === "concat" ? buildConcatMix(recordings, options) : buildRealMix(recordings, options);

  mkdirSync(dirname(out), { recursive: true });
  const json = JSON.stringify(mix);
  writeFileSync(out, json);
  const lengths = mix.map(clip => clip.durationMs / 1000).sort((a, b) => a - b);
  console.log(`Read ${recordings.length} of ${files.length} WAV files.`);
  console.log(`Wrote ${mix.length} clips (${mode}) to ${out} (${(json.length / 1024 / 1024).toFixed(1)} MB).`);
  console.log(`Clip length: min ${lengths[0].toFixed(1)}s, median ${lengths[Math.floor(lengths.length / 2)].toFixed(1)}s, max ${lengths.at(-1).toFixed(1)}s.`);
}

main();
