import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const workbook = await SpreadsheetFile.importXlsx(
  await FileBlob.load("D:/Code/HuaMei/App_noi/be/9_10th8/speaking-ai-nextjs-backend/outputs/xlsx-dynamic-cost/trien-khai-model-ai-chi-phi-tu-dong.xlsx"),
);

console.log(workbook.help("*", {
  search: "worksheet|worksheets|delete|remove",
  include: "index,examples,notes",
  maxChars: 9000,
}).ndjson);
