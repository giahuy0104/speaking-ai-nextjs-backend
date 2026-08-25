import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "C:/Users/DELL/Downloads/Triển khai Model AI.xlsx";
const outDir = "D:/Code/HuaMei/App_noi/be/9_10th8/speaking-ai-nextjs-backend/.codex-tmp/xlsx-dynamic-cost";

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const overview = await workbook.inspect({
  kind: "workbook,sheet,table,definedName,drawing",
  include: "id,name,range,values,formulas",
  maxChars: 12000,
  tableMaxRows: 20,
  tableMaxCols: 12,
  tableMaxCellChars: 120,
});
console.log("OVERVIEW");
console.log(overview.ndjson);

const formulas = await workbook.inspect({
  kind: "formula",
  maxChars: 12000,
  options: { maxResults: 300 },
});
console.log("FORMULAS");
console.log(formulas.ndjson);

const sheets = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 4000 });
const names = [];
for (const line of sheets.ndjson.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const record = JSON.parse(line);
    if (record.name) names.push(record.name);
  } catch {}
}
console.log("SHEET_NAMES", JSON.stringify(names));

for (let i = 0; i < names.length; i += 1) {
  const name = names[i];
  const preview = await workbook.render({ sheetName: name, autoCrop: "all", scale: 1.5, format: "png" });
  await fs.writeFile(`${outDir}/preview-${i + 1}.png`, new Uint8Array(await preview.arrayBuffer()));
}
