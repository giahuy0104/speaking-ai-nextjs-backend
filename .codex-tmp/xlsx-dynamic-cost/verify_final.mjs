import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const outputPath = "D:/Code/HuaMei/App_noi/be/9_10th8/speaking-ai-nextjs-backend/outputs/xlsx-dynamic-cost/trien-khai-model-ai-chi-phi-tu-dong.xlsx";
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));

const formulas = await workbook.inspect({
  kind: "formula",
  maxChars: 12000,
  options: { maxResults: 300 },
});
console.log("EXPORTED_FORMULAS");
console.log(formulas.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "exported workbook formula error scan",
});
console.log("EXPORTED_ERROR_SCAN");
console.log(errors.ndjson);

const config = workbook.worksheets.getItem("Cấu hình");
config.getRange("B3").values = [[12]];
const scenario12 = await workbook.inspect({
  kind: "table",
  sheetId: "Trang tính2",
  range: "B5:E19",
  include: "values,formulas",
  tableMaxRows: 20,
  tableMaxCols: 6,
  tableMaxCellChars: 180,
  maxChars: 14000,
});
console.log("EXPORTED_SCENARIO_12");
console.log(scenario12.ndjson);
