import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import fs from "node:fs/promises";

const workbookPath = process.argv[2];
if (!workbookPath) {
  throw new Error("Missing workbook path");
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));

const preview = await workbook.render({
  sheetName: "Test Cases",
  autoCrop: "all",
  scale: 1,
  format: "png",
});
await fs.writeFile(
  "./original-test-cases.png",
  new Uint8Array(await preview.arrayBuffer()),
);

async function runInspect(label, request) {
  const result = await workbook.inspect(request);
  process.stdout.write(`\n===== ${label} =====\n`);
  process.stdout.write(`${result.ndjson ?? JSON.stringify(result)}\n`);
}

await runInspect("SHEETS", {
  kind: "sheet",
  include: "id,name",
  summary: "Workbook sheets",
});

await runInspect("WORKBOOK_OVERVIEW", {
  kind: "workbook,sheet,table",
  include: "values,formulas",
  summary: "Workbook structure and populated ranges",
  maxChars: 40000,
});

await runInspect("MAIN_REFERENCES", {
  kind: "match",
  searchTerm: "Main|MAIN|main|Button Main|button main|nút Main|nhấn Main|nhấn giữ",
  options: {
    useRegex: true,
    maxResults: 500,
  },
  summary: "Cells referring to the Main button",
  maxChars: 30000,
});

await runInspect("TEST_CASE_IDENTIFIERS", {
  kind: "match",
  searchTerm: "TC[-_ ]?[0-9]+|Test Case|test case|Kiểm thử|Kịch bản",
  options: {
    useRegex: true,
    maxResults: 500,
  },
  summary: "Likely test case rows and labels",
  maxChars: 30000,
});
