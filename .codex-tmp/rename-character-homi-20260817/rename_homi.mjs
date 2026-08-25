import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [mode, inputPath, outputPath, previewDir] = process.argv.slice(2);
if (!mode || !inputPath) {
  throw new Error("Usage: node rename_homi.mjs <inspect|edit> <input.xlsx> [output.xlsx] [previewDir]");
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const characterPattern = /(?<![\p{L}\p{N}_])(?:bi\s*cô|bí\s*cô|bi\s+co|pico|pipo)(?![\p{L}\p{N}_])/giu;

function replaceCharacterName(value) {
  return value.replace(characterPattern, "HOMI");
}

function collectMatches() {
  const matches = [];
  for (const sheet of workbook.worksheets.items) {
    const used = sheet.getUsedRange();
    if (!used) continue;
    const values = used.values;
    for (let r = 0; r < values.length; r += 1) {
      for (let c = 0; c < values[r].length; c += 1) {
        const value = values[r][c];
        if (typeof value !== "string") continue;
        const replaced = replaceCharacterName(value);
        if (replaced !== value) {
          matches.push({
            sheet: sheet.name,
            row: used.rowIndex + r + 1,
            column: used.columnIndex + c + 1,
            before: value,
            after: replaced,
          });
        }
      }
    }
  }
  return matches;
}

async function renderAll(targetDir) {
  if (!targetDir) return;
  await fs.mkdir(targetDir, { recursive: true });
  for (const sheet of workbook.worksheets.items) {
    const used = sheet.getUsedRange();
    if (!used) continue;
    const safe = sheet.name.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
    const blob = await workbook.render({
      sheetName: sheet.name,
      range: used.address,
      autoCrop: "all",
      scale: 1,
      format: "png",
    });
    await fs.writeFile(path.join(targetDir, `${safe}.png`), new Uint8Array(await blob.arrayBuffer()));
  }
}

if (mode === "inspect") {
  const overview = await workbook.inspect({
    kind: "workbook,sheet,table,drawing",
    maxChars: 12000,
    tableMaxRows: 6,
    tableMaxCols: 12,
    tableMaxCellChars: 100,
  });
  const matches = collectMatches();
  console.log("===== OVERVIEW =====");
  console.log(overview.ndjson);
  console.log("===== CHARACTER NAME MATCHES =====");
  console.log(JSON.stringify({ count: matches.length, examples: matches.slice(0, 25) }, null, 2));
  await renderAll(previewDir);
  process.exit(0);
}

if (mode !== "edit" || !outputPath) {
  throw new Error("Edit mode requires an output path.");
}

const matchesBefore = collectMatches();
for (const match of matchesBefore) {
  const sheet = workbook.worksheets.getItem(match.sheet);
  sheet.getCell(match.row - 1, match.column - 1).values = [[match.after]];
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(outputPath);

const remaining = collectMatches();
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
const keyRange = await workbook.inspect({
  kind: "table",
  sheetId: "Test case",
  range: "A1:I20",
  maxChars: 8000,
  tableMaxRows: 20,
  tableMaxCols: 9,
  tableMaxCellChars: 160,
});
console.log("===== KEY RANGE =====");
console.log(keyRange.ndjson);
console.log("===== FORMULA ERRORS =====");
console.log(errors.ndjson);
console.log(JSON.stringify({ replacedCells: matchesBefore.length, remainingMatches: remaining.length, outputPath }));

await renderAll(previewDir);
