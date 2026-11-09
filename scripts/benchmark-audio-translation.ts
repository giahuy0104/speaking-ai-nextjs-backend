import fs from "node:fs/promises";
import path from "node:path";
import { translateAudioToEnglish, getCloudflareAudioTranslationConfig } from "../src/lib/ai/cloudflareWorkersAi";

// An opt-in real-provider comparison: no filename/transcript is fed to a model.
// Usage: node --env-file=.env.local --import tsx scripts/benchmark-audio-translation.ts AUDIO_DIR REPORT.json
async function main() {
const audioDir = process.argv[2];
const output = process.argv[3];
if (!audioDir || !output) throw new Error("Expected AUDIO_DIR and REPORT.json");
const cases = [
  { file: "3-bo-oi-con-khoe-roi.mp3", expected: "Dad, I feel better now.", words: [/\b(dad|father|daddy)\b/i, /\b(better|well|healthy|fine)\b/i] },
  { file: "2-con-nho-ngoai.wav", expected: "I miss Grandma.", words: [/\bmiss\b/i, /\b(grandma|grandmother|granny)\b/i] },
  { file: "003-con-dang-mac-ao.wav", expected: "I am putting on a shirt.", words: [/\b(shirt|clothes|dressing|dressed)\b/i] },
];
const config = getCloudflareAudioTranslationConfig();
const results: Record<string, unknown>[] = [];
for (let repeat = 0; repeat < 2; repeat++) {
  for (const entry of cases) {
    const bytes = await fs.readFile(path.join(audioDir, entry.file));
    // Alternate order to reduce simple warm-up/order bias.
    for (const mode of repeat ? ["optimized", "baseline"] : ["baseline", "optimized"]) {
      const started = performance.now();
      let text = ""; let sourceText; let error;
      try {
        if (mode === "optimized") {
          const result = await translateAudioToEnglish(new File([bytes], entry.file), "vi");
          text = result.englishText; sourceText = result.sourceText;
        } else {
          const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${config.model}`, {
            method: "POST", headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ audio: bytes.toString("base64"), task: "translate", language: "vi", vad_filter: true,
              condition_on_previous_text: false, initial_prompt: "Short everyday speech translated naturally and faithfully into English." }),
            signal: AbortSignal.timeout(20000),
          });
          const body = await response.json();
          text = body.result?.text ?? "";
          if (!response.ok) error = `HTTP ${response.status}`;
        }
      } catch (e) { error = e instanceof Error ? e.message : String(e); }
      const row = { repeat, mode, file: entry.file, expected: entry.expected, ms: Math.round(performance.now() - started), text, sourceText, error,
        // Necessary keyword checks only; inspect transcripts/meaning manually too.
        keywordPass: !error && entry.words.every(pattern => pattern.test(text)) };
      results.push(row); console.log(JSON.stringify(row));
    }
  }
}
await fs.writeFile(output, JSON.stringify(results, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
