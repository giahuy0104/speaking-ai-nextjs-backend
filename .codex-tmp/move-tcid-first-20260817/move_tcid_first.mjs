import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [mode, inputPath, outputPath, previewDir] = process.argv.slice(2);
if (!mode || !inputPath) {
  throw new Error("Usage: node move_tcid_first.mjs <inspect|edit> <input.xlsx> [output.xlsx] [previewDir]");
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheet = workbook.worksheets.getItem("Test case");

function locateHeader() {
  const used = sheet.getUsedRange();
  const values = used.values;
  for (let r = 0; r < values.length; r += 1) {
    const c = values[r].findIndex((value) => String(value ?? "").trim().toUpperCase() === "TC_ID");
    if (c >= 0) return { used, headerRowOffset: r, tcIdColumnOffset: c };
  }
  throw new Error("Không tìm thấy cột TC_ID trong sheet Test case.");
}

async function renderAll(targetDir) {
  if (!targetDir) return;
  await fs.mkdir(targetDir, { recursive: true });
  for (const currentSheet of workbook.worksheets.items) {
    const used = currentSheet.getUsedRange();
    if (!used) continue;
    const safe = currentSheet.name.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
    const blob = await workbook.render({
      sheetName: currentSheet.name,
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
    kind: "workbook,sheet,table",
    maxChars: 12000,
    tableMaxRows: 8,
    tableMaxCols: 12,
    tableMaxCellChars: 100,
  });
  const { used, headerRowOffset, tcIdColumnOffset } = locateHeader();
  const widths = Array.from({ length: used.columnCount }, (_, index) =>
    sheet.getCell(used.rowIndex + headerRowOffset, used.columnIndex + index).format.columnWidth,
  );
  const actualTables = sheet.tables.items.map((table) => ({
    name: table.name,
    address: table.getRange().address,
    headerAddress: table.getHeaderRowRange().address,
  }));
  console.log("===== OVERVIEW =====");
  console.log(overview.ndjson);
  console.log(JSON.stringify({
    usedRange: used.address,
    headerRow: used.rowIndex + headerRowOffset + 1,
    tcIdColumn: used.columnIndex + tcIdColumnOffset + 1,
    widths,
    actualTables,
  }, null, 2));
  await renderAll(previewDir);
  process.exit(0);
}

if (mode !== "edit" || !outputPath) {
  throw new Error("Edit mode requires an output path.");
}

const { used, headerRowOffset, tcIdColumnOffset } = locateHeader();
if (tcIdColumnOffset > 0) {
  const firstRow = used.rowIndex + headerRowOffset;
  const rowCount = used.rowCount - headerRowOffset;
  const firstColumn = used.columnIndex;
  const tempColumn = used.columnIndex + used.columnCount;
  const widths = Array.from({ length: used.columnCount }, (_, index) =>
    sheet.getCell(firstRow, firstColumn + index).format.columnWidth,
  );

  const tempRange = sheet.getRangeByIndexes(firstRow, tempColumn, rowCount, 1);
  const tcIdRange = sheet.getRangeByIndexes(firstRow, firstColumn + tcIdColumnOffset, rowCount, 1);
  tempRange.copyFrom(tcIdRange, "all");

  for (let offset = tcIdColumnOffset; offset >= 1; offset -= 1) {
    const target = sheet.getRangeByIndexes(firstRow, firstColumn + offset, rowCount, 1);
    const source = sheet.getRangeByIndexes(firstRow, firstColumn + offset - 1, rowCount, 1);
    target.copyFrom(source, "all");
  }

  sheet.getRangeByIndexes(firstRow, firstColumn, rowCount, 1).copyFrom(tempRange, "all");
  tempRange.clear({ applyTo: "all" });

  const reorderedWidths = [
    widths[tcIdColumnOffset],
    ...widths.slice(0, tcIdColumnOffset),
    ...widths.slice(tcIdColumnOffset + 1),
  ];
  reorderedWidths.forEach((width, index) => {
    if (typeof width === "number" && Number.isFinite(width)) {
      sheet.getRangeByIndexes(used.rowIndex, firstColumn + index, used.rowCount, 1).format.columnWidth = width;
    }
  });

  const oldPriorityRange = sheet.getRangeByIndexes(firstRow + 1, firstColumn + 2, rowCount - 1, 1);
  const priorityRange = sheet.getRangeByIndexes(firstRow + 1, firstColumn + 3, rowCount - 1, 1);
  oldPriorityRange.conditionalFormats.clear();
  priorityRange.conditionalFormats.clear();
  priorityRange.conditionalFormats.add("containsText", {
    text: "P0 - Critical",
    format: { fill: "#FDE9E7", font: { color: "#D93632" } },
  });
  priorityRange.conditionalFormats.add("containsText", {
    text: "P1 - High",
    format: { fill: "#FFF2CC", font: { color: "#B7791F" } },
  });
  priorityRange.conditionalFormats.add("containsText", {
    text: "P2 - Medium",
    format: { fill: "#E2F0D9", font: { color: "#2E7D32" } },
  });
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(outputPath);

const verify = await workbook.inspect({
  kind: "table",
  sheetId: "Test case",
  range: "A1:I15",
  maxChars: 10000,
  tableMaxRows: 15,
  tableMaxCols: 9,
  tableMaxCellChars: 160,
});
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
const after = locateHeader();
console.log("===== VERIFY =====");
console.log(verify.ndjson);
console.log("===== FORMULA ERRORS =====");
console.log(errors.ndjson);
console.log(JSON.stringify({
  outputPath,
  usedRange: sheet.getUsedRange().address,
  tcIdColumnAfter: after.used.columnIndex + after.tcIdColumnOffset + 1,
}));

await renderAll(previewDir);
