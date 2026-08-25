import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = process.argv[2];
const outputDir = process.argv[3];

if (!inputPath || !outputDir) {
  throw new Error("Usage: analyze.mjs <input.xlsx> <output-dir>");
}

await fs.mkdir(outputDir, { recursive: true });
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const overview = await workbook.inspect({
  kind: "workbook,sheet,table,drawing,definedName",
  maxChars: 20000,
  tableMaxRows: 15,
  tableMaxCols: 20,
  tableMaxCellChars: 160,
});
await fs.writeFile(path.join(outputDir, "overview.ndjson"), overview.ndjson, "utf8");

const sheetInspection = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 12000,
});
await fs.writeFile(
  path.join(outputDir, "sheets.ndjson"),
  sheetInspection.ndjson,
  "utf8",
);

const formulas = await workbook.inspect({
  kind: "formula",
  maxChars: 30000,
  options: { maxResults: 500 },
});
await fs.writeFile(path.join(outputDir, "formulas.ndjson"), formulas.ndjson, "utf8");

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!",
  options: { useRegex: true, maxResults: 500 },
  summary: "formula error scan",
});
await fs.writeFile(path.join(outputDir, "errors.ndjson"), errors.ndjson, "utf8");

const parseNdjson = (text) =>
  text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const sheetRecords = parseNdjson(sheetInspection.ndjson);
const names = [
  ...new Set(
    sheetRecords
      .flatMap((record) => [record.name, record.sheetName, record.title])
      .filter((value) => typeof value === "string" && value.length > 0),
  ),
];

const firstSheet = workbook.worksheets.getItem(names[0]);
const usedRange = firstSheet.getUsedRange();
const usedValues = await usedRange.values;
const normalizedRange = firstSheet.getRange(`J2:J${usedValues.length}`);
const normalizedFormulas = await normalizedRange.formulas;
const normalizedDisplayFormulas = await normalizedRange.displayFormulas;

const headers = usedValues[0].map((value) => String(value ?? ""));
const records = usedValues.slice(1).map((row, index) => ({
  excelRow: index + 2,
  row: Object.fromEntries(headers.map((header, col) => [header, row[col] ?? null])),
}));

const countBy = (key) =>
  Object.fromEntries(
    [...records.reduce((counts, record) => {
      const value = String(record.row[key] ?? "(blank)");
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );

const groupedPhrases = records.reduce((groups, record) => {
  const phrase = String(record.row.normalized_phrase ?? "").trim();
  if (!groups.has(phrase)) groups.set(phrase, []);
  groups.get(phrase).push(record);
  return groups;
}, new Map());

const duplicatePhrases = [...groupedPhrases.entries()]
  .filter(([phrase, group]) => phrase && group.length > 1)
  .map(([phrase, group]) => ({
    phrase,
    occurrences: group.length,
    rows: group.map(({ excelRow, row }) => ({
      excelRow,
      intent_id: row.intent_id,
      state_scope: row.state_scope,
      priority_rule: row["priority_rule (đề xuất kỹ thuật)"],
    })),
    distinctIntents: [...new Set(group.map(({ row }) => row.intent_id))],
  }));

const conflicts = duplicatePhrases.filter((entry) => entry.distinctIntents.length > 1);
const exactDuplicateMappings = duplicatePhrases.filter(
  (entry) => entry.distinctIntents.length === 1,
);

const missingCells = records.flatMap(({ excelRow, row }) =>
  headers
    .filter((header) => row[header] === null || String(row[header]).trim() === "")
    .map((header) => ({ excelRow, header })),
);

const sttIssues = records
  .filter(({ row }, index) => Number(row.STT) !== index + 1)
  .map(({ excelRow, row }, index) => ({
    excelRow,
    expected: index + 1,
    actual: row.STT,
  }));

const normalizationMismatches = records
  .filter(({ row }) =>
    String(row.controlled_phrase_vi ?? "").trim().toLocaleLowerCase("vi-VN") !==
    String(row.normalized_phrase ?? ""),
  )
  .map(({ excelRow, row }) => ({
    excelRow,
    controlled: row.controlled_phrase_vi,
    normalized: row.normalized_phrase,
  }));

const stats = {
  dimensions: { rows: usedValues.length, columns: headers.length, dataRows: records.length },
  headers,
  counts: {
    module: countBy("module"),
    intent: countBy("intent_id"),
    stateScope: countBy("state_scope"),
    priority: countBy("priority_rule (đề xuất kỹ thuật)"),
    phraseType: countBy("phrase_type"),
    lexiconVersion: countBy("lexicon_version"),
  },
  missingCells,
  sttIssues,
  normalizationMismatches,
  duplicatePhrases,
  conflicts,
  exactDuplicateMappings,
  formulaCells: normalizedFormulas.flatMap((row, index) =>
    row[0] ? [{ excelRow: index + 2, formula: row[0], displayFormula: normalizedDisplayFormulas[index]?.[0] }] : [],
  ),
};
await fs.writeFile(path.join(outputDir, "stats.json"), JSON.stringify(stats, null, 2), "utf8");

const renders = [];
for (const name of names) {
  const preview = await workbook.render({
    sheetName: name,
    autoCrop: "all",
    scale: 1.5,
    format: "png",
  });
  const safeName = name.replace(/[<>:"/\\|?*]+/g, "_");
  const renderPath = path.join(outputDir, `${safeName}.png`);
  await fs.writeFile(renderPath, new Uint8Array(await preview.arrayBuffer()));
  renders.push({ name, renderPath });
}

console.log(
  JSON.stringify(
    {
      inputPath,
      outputDir,
      sheetNames: names,
      renders,
      stats,
      formulaErrors: parseNdjson(errors.ndjson),
    },
    null,
    2,
  ),
);
