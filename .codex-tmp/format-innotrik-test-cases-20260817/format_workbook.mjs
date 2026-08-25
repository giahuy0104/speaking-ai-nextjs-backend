import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const mode = process.argv[2];
const inputPath = process.argv[3];
const outputPath = process.argv[4];
const previewDir = process.argv[5];

if (!mode || !inputPath || !previewDir) {
  throw new Error("Usage: format_workbook.mjs <inspect|format> <input.xlsx> [output.xlsx] <preview-dir>");
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheetNames = ["Test case", "Child"];

await fs.mkdir(previewDir, { recursive: true });

function safeName(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

async function renderAll(prefix) {
  for (const sheetName of sheetNames) {
    const preview = await workbook.render({
      sheetName,
      autoCrop: "all",
      scale: sheetName === "Test case" ? 0.8 : 1,
      format: "png",
    });
    await fs.writeFile(
      path.join(previewDir, `${prefix}-${safeName(sheetName)}.png`),
      new Uint8Array(await preview.arrayBuffer()),
    );
  }
}

if (mode === "inspect") {
  const overview = await workbook.inspect({
    kind: "workbook,sheet,table",
    maxChars: 6000,
    tableMaxRows: 6,
    tableMaxCols: 10,
    tableMaxCellChars: 80,
  });
  console.log("===== OVERVIEW =====");
  console.log(overview.ndjson);

  for (const [sheetName, range] of [
    ["Test case", "A1:I6"],
    ["Child", "A1:G8"],
  ]) {
    const style = await workbook.inspect({
      kind: "computedStyle",
      sheetId: sheetName,
      range,
      maxChars: 5000,
    });
    console.log(`===== STYLE ${sheetName} =====`);
    console.log(style.ndjson);
  }

  await renderAll("before");
  process.exit(0);
}

if (mode !== "format" || !outputPath) {
  throw new Error("Formatting mode requires an output path");
}

const COLORS = {
  navy: "#12325B",
  blue: "#2F5BD3",
  blueLight: "#EAF2FF",
  bluePale: "#F7FAFF",
  text: "#26364A",
  muted: "#5F738C",
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

function applyBase(sheet, usedRangeAddress) {
  sheet.showGridLines = false;
  sheet.getRange(usedRangeAddress).format.font = {
    name: "Aptos",
    size: 10,
    color: COLORS.text,
  };
}

function applyTitle(sheet, titleRange, subtitleRange) {
  sheet.getRange(titleRange).format = {
    fill: COLORS.navy,
    font: { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 17 },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  sheet.getRange(subtitleRange).format = {
    fill: COLORS.blueLight,
    font: { name: "Aptos", italic: true, color: COLORS.muted, size: 10 },
    horizontalAlignment: "left",
    verticalAlignment: "center",
    wrapText: true,
  };
}

function applyHeader(sheet, rangeAddress) {
  sheet.getRange(rangeAddress).format = {
    fill: COLORS.blue,
    font: { name: "Aptos", bold: true, color: "#FFFFFF", size: 10 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: {
      bottom: { style: "medium", color: "#234BB6" },
    },
  };
}

function applyZebra(sheet, startRow, endRow, startColumn, endColumn, rowHeight = 54) {
  for (let row = startRow; row <= endRow; row += 1) {
    const range = sheet.getRange(`${startColumn}${row}:${endColumn}${row}`);
    range.format = {
      fill: row % 2 === 0 ? COLORS.rowBlue : COLORS.rowWhite,
      font: { name: "Aptos", color: COLORS.text, size: 10 },
      verticalAlignment: "top",
      wrapText: true,
      rowHeight,
      borders: {
        bottom: { style: "thin", color: COLORS.line },
      },
    };
  }
}

const testCase = workbook.worksheets.getItem("Test case");
applyBase(testCase, "A1:I94");
applyTitle(testCase, "A1:I1", "A2:I2");
applyHeader(testCase, "A3:I3");
applyZebra(testCase, 4, 94, "A", "I", 54);
testCase.getRange("C4:D94").format.horizontalAlignment = "center";
for (const [column, width] of Object.entries({
  A: 28,
  B: 22,
  C: 14,
  D: 12,
  E: 36,
  F: 48,
  G: 25,
  H: 50,
  I: 20,
})) {
  testCase.getRange(`${column}:${column}`).format.columnWidth = width;
}
testCase.getRange("1:1").format.rowHeight = 32;
testCase.getRange("2:2").format.rowHeight = 28;
testCase.getRange("3:3").format.rowHeight = 34;
testCase.freezePanes.unfreeze();
testCase.freezePanes.freezeRows(3);
testCase.freezePanes.freezeColumns(4);

const child = workbook.worksheets.getItem("Child");
applyBase(child, "A1:G8");
applyHeader(child, "A1:G1");
applyZebra(child, 2, 7, "A", "G", 30);
child.getRange("A2:A7").format.horizontalAlignment = "center";
child.getRange("C2:G7").format.horizontalAlignment = "center";
child.getRange("D2:G8").format.numberFormat = "#,##0";
child.getRange("A8:G8").format = {
  fill: "#DCE8FF",
  font: { name: "Aptos", bold: true, color: COLORS.navy, size: 11 },
  verticalAlignment: "center",
  borders: {
    top: { style: "medium", color: "#234BB6" },
    bottom: { style: "thin", color: COLORS.line },
  },
  rowHeight: 32,
};
child.getRange("A8:C8").format.horizontalAlignment = "right";
child.getRange("D8:G8").format.horizontalAlignment = "center";
for (const [column, width] of Object.entries({
  A: 14,
  B: 23,
  C: 18,
  D: 12,
  E: 12,
  F: 12,
  G: 18,
})) {
  child.getRange(`${column}:${column}`).format.columnWidth = width;
}
child.getRange("1:1").format.rowHeight = 34;
child.freezePanes.unfreeze();
child.freezePanes.freezeRows(1);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

await renderAll("after");

for (const [sheetName, range] of [
  ["Test case", "A1:I15"],
  ["Child", "A1:G8"],
]) {
  const check = await workbook.inspect({
    kind: "table",
    range: `${sheetName}!${range}`,
    include: "values,formulas",
    tableMaxRows: 28,
    tableMaxCols: 10,
    maxChars: 10000,
  });
  console.log(`===== CHECK ${sheetName} =====`);
  console.log(check.ndjson);
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "Final formula error scan",
});
console.log("===== FORMULA_ERRORS =====");
console.log(errors.ndjson);
