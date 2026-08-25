import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const outputPath = "D:/Code/HuaMei/App_noi/be/9_10th8/speaking-ai-nextjs-backend/outputs/xlsx-single-sheet/trien-khai-model-ai-mot-sheet.xlsx";
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));

const sheets = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 3000 });
console.log("EXPORTED_SHEETS");
console.log(sheets.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "exported single-sheet formula error scan",
});
console.log("EXPORTED_ERROR_SCAN");
console.log(errors.ndjson);

const report = workbook.worksheets.getItem("Trang tính2");
report.getRange("E2").values = [[12]];
const scenario = await workbook.inspect({
  kind: "table",
  sheetId: "Trang tính2",
  range: "B5:E19",
  include: "values,formulas",
  tableMaxRows: 20,
  tableMaxCols: 6,
  maxChars: 12000,
});
console.log("EXPORTED_SCENARIO_12");
console.log(scenario.ndjson);
