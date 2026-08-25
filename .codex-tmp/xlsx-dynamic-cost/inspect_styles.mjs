import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "C:/Users/DELL/Downloads/Triển khai Model AI.xlsx";
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));

const targets = [
  ["Trang tính1", "A1:E10"],
  ["Trang tính2", "A1:E19"],
  ["Trang tính2", "A34:D41"],
  ["Trang tính2", "A55:D62"],
];

for (const [sheetId, range] of targets) {
  const result = await workbook.inspect({
    kind: "computedStyle",
    sheetId,
    range,
    maxChars: 9000,
  });
  console.log(`STYLE ${sheetId}!${range}`);
  console.log(result.ndjson);
}
