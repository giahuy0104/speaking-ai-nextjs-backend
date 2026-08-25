import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const workbook = await SpreadsheetFile.importXlsx(
  await FileBlob.load("D:/Code/HuaMei/App_noi/be/9_10th8/speaking-ai-nextjs-backend/outputs/xlsx-dynamic-cost/trien-khai-model-ai-chi-phi-tu-dong.xlsx"),
);

for (const spec of [
  { kind: "sheet", include: "id,name", maxChars: 3000 },
  { kind: "region", sheetId: "Trang tính2", range: "A1:E5", maxChars: 6000 },
  { kind: "computedStyle", sheetId: "Trang tính2", range: "A1:E5", maxChars: 6000 },
  { kind: "formula", sheetId: "Trang tính2", range: "A1:E116", maxChars: 12000, options: { maxResults: 250 } },
]) {
  const result = await workbook.inspect(spec);
  console.log(result.ndjson);
}
