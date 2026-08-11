import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  observedChildSpeechAliases,
  observedChildSpeechAliasRuntimeStats,
} from "../src/lib/ai/observedChildSpeechAliases";
import { normalizeVietnameseForExactMatch } from "../src/lib/ai/exactRules";
import {
  repairVietnameseTranscriptWithCorpus,
  type TranscriptCorpusRepairResult,
} from "../src/lib/ai/transcriptCorpusRepair";

type BenchmarkSuite =
  | "exact_alias"
  | "accent_folded_alias"
  | "canonical_guard"
  | "safety_guard"
  | "production_asr_replay";

type BenchmarkCase = {
  suite: BenchmarkSuite;
  id: string;
  input: string;
  expected: string;
  note?: string;
};

type BenchmarkRow = BenchmarkCase & {
  actual: string;
  pass: boolean;
  repaired: boolean;
  strategy: string;
  score?: number;
  margin?: number;
  ruleId?: string;
  correctionId?: string;
  latencyMs: number;
};

const productionAsrReplayCases: BenchmarkCase[] = [
  {
    suite: "production_asr_replay",
    id: "ASR-20260811-091423",
    input: "còn hết nước",
    expected: "Con khát nước.",
    note: "conv_f841b1d7 · Flutter Web · Mic điện thoại",
  },
  {
    suite: "production_asr_replay",
    id: "ASR-20260811-091434",
    input: "Cậu muốn dỡ tay à?",
    expected: "Con muốn rửa tay.",
    note: "conv_e1d9e063 · Flutter Web · Mic điện thoại",
  },
  {
    suite: "production_asr_replay",
    id: "ASR-20260811-091450",
    input: "Con hát nút",
    expected: "Con khát nước.",
    note: "conv_86da513b · Flutter Web · Mic điện thoại",
  },
];

const safetyGuardTexts = [
  "Con không hát nước.",
  "Bố hát nước ạ.",
  "Con hát một bài.",
  "Còn có một quả báo?",
  "Đây là cái bẫy.",
  "Con lấy cái bẫy.",
  "Không muốn nghe lại.",
  "Anh không hiểu.",
  "Con tên là bé My.",
];

function stripVietnameseDiacritics(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/giu, (letter) => (letter === "Đ" ? "D" : "d"));
}

function isExpected(actual: string, expected: string) {
  return (
    normalizeVietnameseForExactMatch(actual) ===
    normalizeVietnameseForExactMatch(expected)
  );
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return Number(sorted[index].toFixed(4));
}

function runCase(testCase: BenchmarkCase): BenchmarkRow {
  const startedAt = performance.now();
  const result: TranscriptCorpusRepairResult =
    repairVietnameseTranscriptWithCorpus(testCase.input);
  const latencyMs = performance.now() - startedAt;

  return {
    ...testCase,
    actual: result.text,
    pass: isExpected(result.text, testCase.expected),
    repaired: result.repaired,
    strategy: result.strategy ?? "none",
    score: result.score,
    margin: result.margin,
    ruleId: result.ruleId,
    correctionId: result.correctionId,
    latencyMs: Number(latencyMs.toFixed(4)),
  };
}

function buildCases() {
  const exactAliasCases: BenchmarkCase[] = observedChildSpeechAliases.map(
    (alias) => ({
      suite: "exact_alias",
      id: alias.id,
      input: alias.source,
      expected: alias.canonical,
      note: alias.sourceRows.length
        ? `source rows: ${alias.sourceRows.join("|")}`
        : undefined,
    }),
  );

  const accentFoldedAliasCases: BenchmarkCase[] = observedChildSpeechAliases
    .map((alias) => ({ alias, folded: stripVietnameseDiacritics(alias.source) }))
    .filter(
      ({ alias, folded }) =>
        normalizeVietnameseForExactMatch(alias.source) !==
        normalizeVietnameseForExactMatch(folded),
    )
    .map(({ alias, folded }) => ({
      suite: "accent_folded_alias",
      id: `${alias.id}-FOLDED`,
      input: folded,
      expected: alias.canonical,
      note: "Generated accent-folded replay",
    }));

  const canonicalByNormalizedText = new Map<string, string>();
  for (const alias of observedChildSpeechAliases) {
    canonicalByNormalizedText.set(
      normalizeVietnameseForExactMatch(alias.canonical),
      alias.canonical,
    );
  }
  const canonicalGuardCases: BenchmarkCase[] = [
    ...canonicalByNormalizedText.values(),
  ].map((canonical, index) => ({
    suite: "canonical_guard",
    id: `CANONICAL-${String(index + 1).padStart(4, "0")}`,
    input: canonical,
    expected: canonical,
    note: "A standard sentence must retain its meaning",
  }));

  const safetyGuardCases: BenchmarkCase[] = safetyGuardTexts.map(
    (input, index) => ({
      suite: "safety_guard",
      id: `SAFETY-${String(index + 1).padStart(3, "0")}`,
      input,
      expected: input,
      note: "Must not be coerced into a child-speech alias",
    }),
  );

  return [
    ...exactAliasCases,
    ...accentFoldedAliasCases,
    ...canonicalGuardCases,
    ...safetyGuardCases,
    ...productionAsrReplayCases,
  ];
}

function summarizeSuite(rows: BenchmarkRow[], suite: BenchmarkSuite) {
  const suiteRows = rows.filter((row) => row.suite === suite);
  const passed = suiteRows.filter((row) => row.pass).length;
  return {
    total: suiteRows.length,
    passed,
    failed: suiteRows.length - passed,
    passRate:
      suiteRows.length === 0
        ? 0
        : Number((passed / suiteRows.length).toFixed(4)),
  };
}

function countStrategies(rows: BenchmarkRow[]) {
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.strategy] = (result[row.strategy] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(result).sort((left, right) => right[1] - left[1]),
  );
}

function csvValue(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function buildCsv(rows: BenchmarkRow[]) {
  const columns: Array<keyof BenchmarkRow> = [
    "suite",
    "id",
    "input",
    "expected",
    "actual",
    "pass",
    "repaired",
    "strategy",
    "score",
    "margin",
    "latencyMs",
    "ruleId",
    "correctionId",
    "note",
  ];
  return [
    columns.map(csvValue).join(","),
    ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
  ].join("\n");
}

async function main() {
  process.env.CHILD_SPEECH_ALIASES_ENABLED ??= "true";

  const outputArgument = process.argv.find((argument) =>
    argument.startsWith("--output-dir="),
  );
  const outputDir = path.resolve(
    process.cwd(),
    outputArgument?.slice("--output-dir=".length) ||
      "outputs/child-speech-matcher",
  );

  const cases = buildCases();
  for (const warmupCase of cases.slice(0, 200)) {
    repairVietnameseTranscriptWithCorpus(warmupCase.input);
  }

  const rows = cases.map(runCase);
  const suites: BenchmarkSuite[] = [
    "exact_alias",
    "accent_folded_alias",
    "canonical_guard",
    "safety_guard",
    "production_asr_replay",
  ];
  const summary = Object.fromEntries(
    suites.map((suite) => [suite, summarizeSuite(rows, suite)]),
  );
  const latencies = rows.map((row) => row.latencyMs);
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    matcherEnabled: process.env.CHILD_SPEECH_ALIASES_ENABLED !== "false",
    dataset: observedChildSpeechAliasRuntimeStats,
    summary,
    strategyCounts: countStrategies(rows),
    latency: {
      samples: latencies.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      p99Ms: percentile(latencies, 0.99),
      maxMs: Number(Math.max(...latencies).toFixed(4)),
    },
    failures: rows.filter((row) => !row.pass),
    rows,
  };

  await mkdir(outputDir, { recursive: true });
  const safeTimestamp = generatedAt.replace(/[:.]/g, "-");
  const timestampedJson = path.join(
    outputDir,
    `child-speech-matcher-${safeTimestamp}.json`,
  );
  const timestampedCsv = path.join(
    outputDir,
    `child-speech-matcher-${safeTimestamp}.csv`,
  );
  const latestJson = path.join(outputDir, "latest.json");
  const latestCsv = path.join(outputDir, "latest.csv");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const csv = `\uFEFF${buildCsv(rows)}\n`;

  await Promise.all([
    writeFile(timestampedJson, json, "utf8"),
    writeFile(timestampedCsv, csv, "utf8"),
    writeFile(latestJson, json, "utf8"),
    writeFile(latestCsv, csv, "utf8"),
  ]);

  console.log("Child-speech matcher benchmark");
  console.log(`Aliases: ${observedChildSpeechAliasRuntimeStats.aliasCount}`);
  for (const suite of suites) {
    const item = summary[suite];
    console.log(
      `${suite}: ${item.passed}/${item.total} (${(
        item.passRate * 100
      ).toFixed(2)}%)`,
    );
  }
  console.log(
    `Latency: P50 ${report.latency.p50Ms} ms · P95 ${report.latency.p95Ms} ms · P99 ${report.latency.p99Ms} ms`,
  );
  console.log(`JSON: ${latestJson}`);
  console.log(`CSV: ${latestCsv}`);

  const gateFailed =
    summary.exact_alias.failed > 0 ||
    summary.canonical_guard.failed > 0 ||
    summary.safety_guard.failed > 0;
  if (gateFailed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
