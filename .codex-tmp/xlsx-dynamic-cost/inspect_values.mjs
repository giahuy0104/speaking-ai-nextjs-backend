import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const workbook = await SpreadsheetFile.importXlsx(
  await FileBlob.load("C:/Users/DELL/Downloads/Triển khai Model AI.xlsx"),
);

for (const spec of [
  { sheetId: "Trang tính1", range: "A1:E10" },
  { sheetId: "Trang tính2", range: "A1:E19" },
  { sheetId: "Trang tính2", range: "A23:E41" },
  { sheetId: "Trang tính2", range: "A47:E62" },
  { sheetId: "Trang tính2", range: "A100:E106" },
]) {
  const result = await workbook.inspect({
    kind: "table",
    ...spec,
    include: "values,formulas",
    tableMaxRows: 40,
    tableMaxCols: 8,
    tableMaxCellChars: 500,
    maxChars: 25000,
  });
  console.log(`${spec.sheetId}!${spec.range}`);
  console.log(result.ndjson);
}
