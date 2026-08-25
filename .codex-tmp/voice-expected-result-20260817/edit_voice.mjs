import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [mode, inputPath, outputPath, previewDir] = process.argv.slice(2);

if (!mode || !inputPath) {
  throw new Error("Usage: node edit_voice.mjs <inspect|edit> <input.xlsx> [output.xlsx] [previewDir]");
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));

async function savePreview(sheetName, fileName, range) {
  if (!previewDir) return;
  await fs.mkdir(previewDir, { recursive: true });
  const blob = await workbook.render({ sheetName, range, autoCrop: "all", scale: 1, format: "png" });
  await fs.writeFile(path.join(previewDir, fileName), new Uint8Array(await blob.arrayBuffer()));
}

if (mode === "inspect") {
  const overview = await workbook.inspect({
    kind: "workbook,sheet,table",
    maxChars: 16000,
    tableMaxRows: 8,
    tableMaxCols: 14,
    tableMaxCellChars: 120,
  });
  console.log("===== OVERVIEW =====");
  console.log(overview.ndjson);

  for (const sheet of workbook.worksheets.items) {
    const used = sheet.getUsedRange();
    if (!used) continue;
    const safe = sheet.name.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
    await savePreview(sheet.name, `${safe}.png`, used.address);
  }
  process.exit(0);
}

if (mode !== "edit" || !outputPath) {
  throw new Error("Edit mode requires an output path.");
}

let voiceSheet = workbook.worksheets.items.find((sheet) => sheet.name.trim().toLowerCase() === "voice");
if (!voiceSheet) {
  voiceSheet = workbook.worksheets.items.find((sheet) => sheet.name.trim().toLowerCase() === "child");
  if (voiceSheet) voiceSheet.name = "Voice";
}
if (!voiceSheet) {
  throw new Error("Không tìm thấy sheet Voice.");
}

const usedBefore = voiceSheet.getUsedRange();
const rowCount = usedBefore.rowCount;
const colCount = usedBefore.columnCount;
const values = usedBefore.values;
const headerRowIndex = values.findIndex((row) => row.some((cell) => String(cell ?? "").trim().length > 0));
if (headerRowIndex < 0) {
  throw new Error("Sheet Voice không có tiêu đề cột.");
}

const newColIndex = colCount;
const headerCell = voiceSheet.getCell(headerRowIndex, newColIndex);
headerCell.values = [["Kết quả mong muốn"]];

const totalRowIndex = values.findIndex((row, index) => index > headerRowIndex && String(row[0] ?? "").trim().toLowerCase() === "tổng");
const lastDataRowExclusive = totalRowIndex >= 0 ? totalRowIndex : rowCount;
const dataRowCount = Math.max(0, lastDataRowExclusive - headerRowIndex - 1);

if (dataRowCount > 0) {
  const dataRange = voiceSheet.getRangeByIndexes(headerRowIndex + 1, newColIndex, dataRowCount, 1);
  dataRange.values = Array.from({ length: dataRowCount }, () => [0.8]);
  dataRange.format.numberFormat = "0%";
  dataRange.format.horizontalAlignment = "center";
  dataRange.format.verticalAlignment = "center";
}

const priorHeader = newColIndex > 0 ? voiceSheet.getCell(headerRowIndex, newColIndex - 1) : null;
if (priorHeader) {
  headerCell.copyFrom(priorHeader, "all");
  headerCell.values = [["Kết quả mong muốn"]];
}

const priorColumn = newColIndex > 0 && dataRowCount > 0
  ? voiceSheet.getRangeByIndexes(headerRowIndex + 1, newColIndex - 1, dataRowCount, 1)
  : null;
if (priorColumn) {
  const newColumn = voiceSheet.getRangeByIndexes(headerRowIndex + 1, newColIndex, dataRowCount, 1);
  newColumn.copyFrom(priorColumn, "all");
  newColumn.values = Array.from({ length: dataRowCount }, () => [0.8]);
  newColumn.format.numberFormat = "0%";
  newColumn.format.horizontalAlignment = "center";
  newColumn.format.verticalAlignment = "center";
}

if (totalRowIndex >= 0) {
  const priorTotalCell = voiceSheet.getCell(totalRowIndex, newColIndex - 1);
  const newTotalCell = voiceSheet.getCell(totalRowIndex, newColIndex);
  newTotalCell.copyFrom(priorTotalCell, "all");
  newTotalCell.values = [[null]];
}

voiceSheet.getRangeByIndexes(headerRowIndex, newColIndex, rowCount - headerRowIndex, 1).format.columnWidth = 20;

for (const table of voiceSheet.tables.items) {
  const tableRange = table.getRange();
  if (
    tableRange.rowIndex <= headerRowIndex &&
    headerRowIndex < tableRange.rowIndex + tableRange.rowCount &&
    tableRange.columnIndex + tableRange.columnCount === newColIndex
  ) {
    table.resize(voiceSheet.getRangeByIndexes(
      tableRange.rowIndex,
      tableRange.columnIndex,
      tableRange.rowCount,
      tableRange.columnCount + 1,
    ));
  }
}

const newColumnRange = voiceSheet.getRangeByIndexes(headerRowIndex, newColIndex, rowCount - headerRowIndex, 1);
newColumnRange.format.borders = { preset: "all", style: "thin", color: "#1F2937" };
newColumnRange.format.verticalAlignment = "center";

headerCell.format = {
  fill: "#2F61D5",
  font: { bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  wrapText: true,
  borders: { preset: "all", style: "thin", color: "#1F2937" },
};

for (let offset = 0; offset < dataRowCount; offset += 1) {
  const cell = voiceSheet.getCell(headerRowIndex + 1 + offset, newColIndex);
  cell.format.fill = offset % 2 === 0 ? "#E5F2F9" : "#FFFFFF";
  cell.format.font = { color: "#1F3B5B" };
}

if (totalRowIndex >= 0) {
  const totalCell = voiceSheet.getCell(totalRowIndex, newColIndex);
  totalCell.format = {
    fill: "#DCE8FB",
    font: { bold: true, color: "#17365D" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: {
      top: { style: "medium", color: "#3864D9" },
      bottom: { style: "thin", color: "#1F2937" },
      left: { style: "thin", color: "#1F2937" },
      right: { style: "thin", color: "#1F2937" },
    },
  };
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(outputPath);

const verify = await workbook.inspect({
  kind: "table",
  sheetId: voiceSheet.name,
  range: voiceSheet.getUsedRange().address,
  maxChars: 8000,
  tableMaxRows: 12,
  tableMaxCols: 20,
  tableMaxCellChars: 120,
});
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
console.log("===== VOICE VERIFY =====");
console.log(verify.ndjson);
console.log("===== FORMULA ERRORS =====");
console.log(errors.ndjson);

for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange();
  if (!used) continue;
  const safe = sheet.name.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
  await savePreview(sheet.name, `${safe}.png`, used.address);
}

console.log(JSON.stringify({ outputPath, sheet: voiceSheet.name, rowCount, newColumn: newColIndex + 1 }));
