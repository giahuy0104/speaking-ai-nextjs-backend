import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const mode = process.argv[2];
const file1Path = process.argv[3];
const file2Path = process.argv[4];
const outputPath = process.argv[5];
const previewDir = process.argv[6];

if (!mode || !file1Path || !file2Path) {
  throw new Error("Usage: merge_test_cases.mjs <inspect|merge> <file1.xlsx> <file2.xlsx> [output.xlsx] [preview-dir]");
}

const file1 = await SpreadsheetFile.importXlsx(await FileBlob.load(file1Path));
const file2 = await SpreadsheetFile.importXlsx(await FileBlob.load(file2Path));

if (mode === "help") {
  console.log(file2.help("*", { search: "getDataRows|table.rows.add", include: "index,examples,notes", maxChars: 6000 }).ndjson);
  process.exit(0);
}

if (mode === "inspect") {
  for (const [label, workbook] of [["FILE_1", file1], ["FILE_2", file2]]) {
    const overview = await workbook.inspect({
      kind: "workbook,sheet,table",
      include: "values,formulas",
      maxChars: 60000,
      tableMaxRows: 200,
      tableMaxCols: 20,
      tableMaxCellChars: 220,
    });
    console.log(`===== ${label} =====`);
    console.log(overview.ndjson);
  }
  process.exit(0);
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/\b(ung dung|nguoi dung|tre em|tre|bi co|kiem tra|quan sat|cho xu ly|cho ket qua|sau do|lan luot)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(normalize(value).split(" ").filter((token) => token.length > 1));
}

function textSimilarity(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(a.size, b.size);
  return (0.65 * jaccard) + (0.35 * containment);
}

function compareScore(sourceCase, targetCase) {
  return (
    0.5 * textSimilarity(sourceCase.scenario, targetCase.scenario)
    + 0.25 * textSimilarity(sourceCase.expected, targetCase.expected)
    + 0.15 * textSimilarity(sourceCase.steps, targetCase.steps)
    + 0.1 * textSimilarity(sourceCase.data, targetCase.data)
  );
}

function readSourceCases() {
  return file1.worksheets.getItem("Test Cases").getRange("A5:R106").values
    .filter((row) => row[0])
    .map((row) => ({
      id: row[0],
      group: row[1],
      feature: row[2],
      scenario: row[3],
      prerequisite: row[4],
      steps: row[5],
      data: row[6],
      repetitions: row[7],
      expected: row[8],
      metric: row[9],
      priority: row[10],
      type: row[11],
      owner: row[12],
      status: row[13],
      actual: row[14],
      evidence: row[15],
      bugId: row[16],
      notes: row[17],
    }));
}

function readTargetCases() {
  return file2.worksheets.getItem("Test case").getRange("A4:I94").values
    .filter((row) => row[3])
    .map((row) => ({
      group: row[0],
      type: row[1],
      priority: row[2],
      id: row[3],
      scenario: row[4],
      steps: row[5],
      data: row[6],
      expected: row[7],
      notes: row[8],
    }));
}

if (mode === "compare") {
  const sourceCases = readSourceCases();
  const targetCases = readTargetCases();
  const rawTargetRows = file2.worksheets.getItem("Test case").getRange("A4:I94").values;
  const emptyTargetRows = rawTargetRows
    .map((row, index) => ({ row: index + 4, values: row }))
    .filter((entry) => !entry.values[3]);
  console.log(JSON.stringify({ sourceCount: sourceCases.length, targetCount: targetCases.length, emptyTargetRows }));
  for (const sourceCase of sourceCases) {
    const matches = targetCases
      .map((targetCase) => ({
        id: targetCase.id,
        scenario: targetCase.scenario,
        score: compareScore(sourceCase, targetCase),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    console.log(JSON.stringify({
      sourceId: sourceCase.id,
      group: sourceCase.group,
      feature: sourceCase.feature,
      scenario: sourceCase.scenario,
      topMatches: matches.map((match) => ({ ...match, score: Number(match.score.toFixed(3)) })),
    }));
  }
  process.exit(0);
}

if (mode === "tablecheck") {
  const sheet = file2.worksheets.getItem("Test case");
  for (const table of sheet.tables.items) {
    const header = table.getHeaderRowRange().values;
    const data = table.getDataRows().values;
    console.log(JSON.stringify({
      name: table.name,
      header,
      rowCount: data.length,
      firstRows: data.slice(0, 3),
      lastRows: data.slice(-5),
    }));
  }
  process.exit(0);
}

if (mode === "tailcheck") {
  for (const [label, workbook, range] of [
    ["SOURCE_FILE_2", file2, "Test case!A88:I94"],
    ["FILE_1_H20", file1, "Test Cases!A98:R106"],
  ]) {
    const result = await workbook.inspect({
      kind: "table",
      range,
      include: "values,formulas",
      tableMaxRows: 20,
      tableMaxCols: 20,
      maxChars: 12000,
    });
    console.log(`===== ${label} =====`);
    console.log(result.ndjson);
  }
  process.exit(0);
}

if (mode !== "merge" || !outputPath || !previewDir) {
  throw new Error("Merge mode requires output and preview paths");
}

const coveredSourceIds = new Set([
  "TC-009", "TC-010", "TC-011", "TC-014", "TC-015", "TC-016", "TC-017",
  "TC-022", "TC-023", "TC-024", "TC-028", "TC-029", "TC-030", "TC-031", "TC-032",
  "TC-034", "TC-035", "TC-036", "TC-037", "TC-042",
  "TC-046", "TC-049", "TC-050", "TC-051", "TC-052", "TC-053", "TC-054", "TC-055",
  "TC-057", "TC-058", "TC-059",
  "TC-061", "TC-063",
]);

function mapGroup(sourceGroup) {
  const mapping = {
    "Cài đặt & Android": "Cài đặt & Android",
    "Main & Bi cô": "Button Main & Trợ lý Bi cô",
    "Điều hướng AI": "Điều hướng AI",
    "Dịch & Luyện nói": "Dịch & Luyện nói",
    "Chủ đề & Bài học": "Chủ đề & Bài học",
    "Từ vựng & Cài đặt": "Từ vựng & Cài đặt",
    "H20 phần cứng": "H20 & phần cứng",
    "Phi chức năng": "Phi chức năng",
  };
  return mapping[sourceGroup] ?? sourceGroup ?? "Khác";
}

function mapType(sourceCase) {
  if (sourceCase.group === "H20 phần cứng") return "Phần cứng / Offline";
  if (sourceCase.group === "Phi chức năng") return "Phi chức năng";
  const value = normalize(sourceCase.type);
  if (/voice|speech|asr|intent|accent/.test(value)) return "Giọng nói / ASR";
  if (/audio|tts/.test(value)) return "Audio / TTS";
  if (/concurrency|state|lifecycle/.test(value)) return "Trạng thái / Đồng bộ";
  if (/negative|boundary|timeout|recovery|network|error/.test(value)) return "Ngoại lệ / Phục hồi";
  if (/data|persistence|storage/.test(value)) return "Dữ liệu / Lưu trữ";
  if (/usability|ui|accessibility/.test(value)) return "UI / Hiển thị";
  if (/performance|soak|security|privacy/.test(value)) return "Phi chức năng";
  return "Chức năng";
}

function mapPriority(value) {
  const normalized = String(value ?? "").toUpperCase();
  if (normalized.includes("P0")) return "P0 - Critical";
  if (normalized.includes("P1")) return "P1 - High";
  return "P2 - Medium";
}

const sourceCases = readSourceCases();
const missingCases = sourceCases.filter((sourceCase) => !coveredSourceIds.has(sourceCase.id));

if (missingCases.length !== 69) {
  throw new Error(`Expected 69 missing cases after review, received ${missingCases.length}`);
}

const targetSheet = file2.worksheets.getItem("Test case");
const targetTable = targetSheet.tables.items[0];
if (!targetTable) {
  throw new Error("The Test case table was not found in file 2");
}

const appendedRows = missingCases.map((sourceCase) => {
  const sourceNumber = String(sourceCase.id).replace(/\D/g, "").padStart(3, "0");
  const steps = [
    sourceCase.prerequisite ? `Điều kiện trước: ${sourceCase.prerequisite}` : null,
    sourceCase.steps ? `Các bước:\n${sourceCase.steps}` : null,
  ].filter(Boolean).join("\n");
  const data = [
    sourceCase.data || null,
    sourceCase.repetitions != null ? `Số lần: ${sourceCase.repetitions}` : null,
  ].filter(Boolean).join("\n");
  const expected = [
    sourceCase.expected || null,
    sourceCase.metric ? `Chỉ số đạt: ${sourceCase.metric}` : null,
  ].filter(Boolean).join("\n");
  const notes = [
    `Nguồn: Field Test Plan v1.0 — ${sourceCase.id}`,
    sourceCase.feature ? `Tính năng: ${sourceCase.feature}` : null,
    sourceCase.type ? `Loại gốc: ${sourceCase.type}` : null,
    sourceCase.owner ? `Phụ trách: ${sourceCase.owner}` : null,
    sourceCase.status ? `Status: ${sourceCase.status}` : null,
  ].filter(Boolean).join(" | ");

  return [
    mapGroup(sourceCase.group),
    mapType(sourceCase),
    mapPriority(sourceCase.priority),
    `FP-${sourceNumber}`,
    sourceCase.scenario,
    steps,
    data,
    expected,
    notes,
  ];
});

  const originalTargetCount = readTargetCases().length;
  targetTable.rows.add(null, appendedRows);

  const firstNewRow = 4 + originalTargetCount;
const lastNewRow = firstNewRow + appendedRows.length - 1;
const COLORS = {
  text: "#26364A",
  rowBlue: "#EAF5FB",
  rowWhite: "#FFFFFF",
  line: "#C9D8EA",
  p0Fill: "#FDE8E7",
  p0Text: "#B42318",
  p1Fill: "#FFF1D6",
  p1Text: "#9A5B00",
  p2Fill: "#E7F4EA",
  p2Text: "#176B3A",
};

for (let row = firstNewRow; row <= lastNewRow; row += 1) {
  targetSheet.getRange(`A${row}:I${row}`).format = {
    fill: row % 2 === 0 ? COLORS.rowBlue : COLORS.rowWhite,
    font: { name: "Aptos", color: COLORS.text, size: 10 },
    verticalAlignment: "top",
    wrapText: true,
    rowHeight: 68,
    borders: {
      bottom: { style: "thin", color: COLORS.line },
    },
  };
}
targetSheet.getRange(`C${firstNewRow}:D${lastNewRow}`).format.horizontalAlignment = "center";

targetSheet.getRange(`C${firstNewRow}:C${lastNewRow}`).conditionalFormats.add("containsText", {
  text: "P0",
  format: { fill: COLORS.p0Fill, font: { color: COLORS.p0Text, bold: true } },
});
targetSheet.getRange(`C${firstNewRow}:C${lastNewRow}`).conditionalFormats.add("containsText", {
  text: "P1",
  format: { fill: COLORS.p1Fill, font: { color: COLORS.p1Text, bold: true } },
});
targetSheet.getRange(`C${firstNewRow}:C${lastNewRow}`).conditionalFormats.add("containsText", {
  text: "P2",
  format: { fill: COLORS.p2Fill, font: { color: COLORS.p2Text, bold: true } },
});

const groupValues = [
  "Button Main & Trợ lý Bi cô",
  "Điều hướng học chủ đề",
  "Luyện nói",
  "Dịch tiếng Anh",
  "Chủ đề & lời mở đầu",
  "Bài học & đánh giá câu nói",
  "Button Main trong bài học",
  "Cuối bài & học lại chủ đề",
  "Từ vựng",
  "H20 & phần cứng",
  "Cài đặt & Android",
  "Điều hướng AI",
  "Dịch & Luyện nói",
  "Chủ đề & Bài học",
  "Từ vựng & Cài đặt",
  "Phi chức năng",
];
const typeValues = [
  "Chức năng",
  "Điều hướng",
  "Giọng nói / ASR",
  "Audio / TTS",
  "Trạng thái / Đồng bộ",
  "Ngoại lệ / Phục hồi",
  "Dữ liệu / Lưu trữ",
  "UI / Hiển thị",
  "Phần cứng / Offline",
  "Phi chức năng",
];
targetSheet.getRange(`A${firstNewRow}:A${lastNewRow}`).dataValidation = {
  rule: { type: "list", values: groupValues },
};
targetSheet.getRange(`B${firstNewRow}:B${lastNewRow}`).dataValidation = {
  rule: { type: "list", values: typeValues },
};
targetSheet.getRange(`C${firstNewRow}:C${lastNewRow}`).dataValidation = {
  rule: { type: "list", values: ["P0 - Critical", "P1 - High", "P2 - Medium"] },
};

const subtitle = targetSheet.getRange("A2").values[0]?.[0] ?? "";
targetSheet.getRange("A2").values = [[
  `${subtitle} Đã bổ sung ${missingCases.length} test case còn thiếu từ Field Test Plan v1.0.`,
]];

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.mkdir(previewDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(file2);
await output.save(outputPath);

for (const sheetName of ["Test case", "Child"]) {
  const preview = await file2.render({
    sheetName,
    autoCrop: "all",
    scale: sheetName === "Test case" ? 0.65 : 1.2,
    format: "png",
  });
  await fs.writeFile(
    path.join(previewDir, `${sheetName.replace(/\s+/g, "-").toLowerCase()}.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
}

const addedCheck = await file2.inspect({
  kind: "table",
  range: `Test case!A${firstNewRow}:I${lastNewRow}`,
  include: "values,formulas",
  tableMaxRows: appendedRows.length,
  tableMaxCols: 9,
  tableMaxCellChars: 180,
  maxChars: 25000,
});
console.log("===== ADDED_CASES =====");
console.log(addedCheck.ndjson);

const overview = await file2.inspect({
  kind: "workbook,sheet,table",
  maxChars: 4000,
  tableMaxRows: 4,
  tableMaxCols: 10,
});
console.log("===== OUTPUT_OVERVIEW =====");
console.log(overview.ndjson);

const errors = await file2.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "Final formula error scan",
});
console.log("===== FORMULA_ERRORS =====");
console.log(errors.ndjson);

console.log(JSON.stringify({
  sourceCases: sourceCases.length,
  coveredCases: coveredSourceIds.size,
  addedCases: missingCases.length,
  firstNewRow,
  lastNewRow,
  addedSourceIds: missingCases.map((sourceCase) => sourceCase.id),
}));
