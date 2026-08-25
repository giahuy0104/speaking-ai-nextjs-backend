import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = process.argv[2];
const outputPath = process.argv[3];
const previewDir = process.argv[4];

if (!inputPath || !outputPath || !previewDir) {
  throw new Error("Usage: classify_workbook.mjs <input.xlsx> <output.xlsx> <preview-dir>");
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const source = workbook.worksheets.getItem("Test Cases");
const sourceRows = source.getRange("A5:G95").values;

const groups = [
  "Button Main & Trợ lý Bi cô",
  "Điều hướng học chủ đề",
  "Luyện nói",
  "Dịch tiếng Anh",
  "Chủ đề & lời mở đầu",
  "Bài học & đánh giá câu nói",
  "Button Main trong bài học",
  "Cuối bài & học lại chủ đề",
  "Từ vựng",
  "H20 & phần cứng",
];

const mainRelations = [
  "Main - trực tiếp",
  "Luồng sau Main",
  "Ngoài Button Main",
  "MAIN phần cứng",
];

const testTypes = [
  "Chức năng",
  "Điều hướng",
  "Giọng nói / ASR",
  "Audio / TTS",
  "Trạng thái / Đồng bộ",
  "Ngoại lệ / Phục hồi",
  "Dữ liệu / Lưu trữ",
  "UI / Hiển thị",
  "Phần cứng / Offline",
];

const priorities = ["P0 - Critical", "P1 - High", "P2 - Medium"];

function tcNumber(tcId) {
  const match = String(tcId ?? "").match(/(\d+)/);
  return match ? Number(match[1]) : 9999;
}

function featureGroup(id) {
  if (id >= 2 && id <= 16) return groups[0];
  if (id >= 20 && id <= 28) return groups[1];
  if (id >= 29 && id <= 40) return groups[2];
  if (id >= 41 && id <= 47) return groups[3];
  if (id >= 48 && id <= 56) return groups[4];
  if (id >= 57 && id <= 69) return groups[5];
  if (id >= 70 && id <= 74) return groups[6];
  if (id === 75) return groups[5];
  if (id >= 76 && id <= 86) return groups[7];
  if (id >= 87 && id <= 93) return groups[8];
  if (id >= 94 && id <= 96) return groups[9];
  return "Chưa phân loại";
}

const directMainIds = new Set([
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  29, 41, 70, 71, 72, 73, 74, 87,
]);

function mainRelation(id) {
  if (directMainIds.has(id)) return mainRelations[0];
  if ((id >= 20 && id <= 28) || (id >= 30 && id <= 40) || (id >= 42 && id <= 53)) {
    return mainRelations[1];
  }
  if (id === 94) return mainRelations[3];
  return mainRelations[2];
}

const timeoutIds = new Set([7, 8, 35, 38, 45, 64]);
const recoveryIds = new Set([22, 25, 28, 38, 39, 45, 47, 54, 64, 71, 78, 85, 86]);
const dataIds = new Set([67, 68, 69, 88, 90, 91, 92, 93]);
const audioIds = new Set([3, 9, 10, 11, 33, 40, 51, 52, 57, 58, 59, 75, 89]);
const stateIds = new Set([5, 8, 9, 10, 11, 30, 34, 40, 53, 70, 71, 72, 73, 74, 86]);
const uiIds = new Set([2, 20, 23, 32, 48, 50, 87, 90, 91, 92]);
const navigationIds = new Set([12, 13, 14, 15, 21, 22, 24, 25, 26, 28, 36, 37, 41, 49, 50, 53, 55, 56, 76, 77, 79, 80, 81, 82, 83, 84, 85, 86, 87]);
const asrIds = new Set([4, 6, 16, 21, 22, 24, 25, 26, 31, 36, 37, 41, 42, 43, 44, 46, 60, 61, 62, 63, 65, 66, 70, 72, 73, 74, 76, 77, 78, 80, 81, 82, 83, 84, 85, 87]);

function testType(id) {
  if (id >= 94 && id <= 96) return "Phần cứng / Offline";
  if (dataIds.has(id)) return "Dữ liệu / Lưu trữ";
  if (timeoutIds.has(id) || recoveryIds.has(id)) return "Ngoại lệ / Phục hồi";
  if (stateIds.has(id)) return "Trạng thái / Đồng bộ";
  if (audioIds.has(id)) return "Audio / TTS";
  if (uiIds.has(id)) return "UI / Hiển thị";
  if (navigationIds.has(id)) return "Điều hướng";
  if (asrIds.has(id)) return "Giọng nói / ASR";
  return "Chức năng";
}

const p0Ids = new Set([
  3, 5, 8, 9, 10, 11, 12, 13, 14, 15, 29, 30, 31, 34, 35, 38, 39,
  41, 47, 50, 51, 52, 53, 59, 60, 61, 63, 64, 65, 66, 70, 71, 72, 73,
  74, 77, 79, 80, 81, 82, 83, 84, 86, 87, 94, 95, 96,
]);

const p2Ids = new Set([
  16, 20, 23, 26, 32, 33, 43, 44, 46, 48, 54, 55, 56, 58, 62,
  67, 68, 69, 75, 76, 78, 85, 88, 89, 90, 91, 92, 93,
]);

function priority(id) {
  if (p0Ids.has(id)) return priorities[0];
  if (p2Ids.has(id)) return priorities[2];
  return priorities[1];
}

const classifiedRows = sourceRows
  .filter((row) => row[0])
  .map((row) => {
    const id = tcNumber(row[0]);
    return [
      featureGroup(id),
      mainRelation(id),
      testType(id),
      priority(id),
      row[0],
      row[2],
      row[3],
      row[4],
      row[5],
      row[6],
    ];
  })
  .sort((a, b) => {
    const groupCompare = groups.indexOf(a[0]) - groups.indexOf(b[0]);
    return groupCompare || tcNumber(a[4]) - tcNumber(b[4]);
  });

const classified = workbook.worksheets.add("Phân loại");
classified.showGridLines = false;
classified.getRange("A1:J1").merge();
classified.getRange("A1").values = [["INNOTRIK — TEST CASE ĐÃ PHÂN LOẠI"]];
classified.getRange("A2:J2").merge();
classified.getRange("A2").values = [[
  "Tách riêng Button Main, luồng sau Main và các tính năng độc lập. Dùng bộ lọc tại hàng tiêu đề để tạo test suite theo phạm vi.",
]];

const headers = [[
  "Nhóm chức năng",
  "Liên quan Button Main",
  "Loại kiểm thử",
  "Ưu tiên",
  "TC_ID",
  "Test scenario",
  "Test steps",
  "Test data",
  "Expected result",
  "Notes",
]];

classified.getRange("A3:J3").values = headers;
classified.getRange(`A4:J${classifiedRows.length + 3}`).values = classifiedRows;

const classifiedTable = classified.tables.add(
  `A3:J${classifiedRows.length + 3}`,
  true,
  "ClassifiedTestCases",
);
classifiedTable.style = "TableStyleMedium2";
classifiedTable.showFilterButton = true;

classified.getRange("A1:J1").format = {
  fill: "#12325B",
  font: { bold: true, color: "#FFFFFF", size: 17 },
  horizontalAlignment: "left",
  verticalAlignment: "center",
};
classified.getRange("A2:J2").format = {
  fill: "#EAF2FF",
  font: { italic: true, color: "#46607F", size: 10 },
  verticalAlignment: "center",
};
classified.getRange("A3:J3").format = {
  fill: "#2F5BD3",
  font: { bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  wrapText: true,
};
classified.getRange(`A4:J${classifiedRows.length + 3}`).format = {
  verticalAlignment: "top",
  wrapText: true,
  font: { color: "#26364A", size: 10 },
  rowHeight: 54,
};
classified.getRange(`D4:E${classifiedRows.length + 3}`).format.horizontalAlignment = "center";

const widths = {
  A: 29,
  B: 22,
  C: 22,
  D: 14,
  E: 12,
  F: 36,
  G: 48,
  H: 25,
  I: 50,
  J: 20,
};
for (const [column, width] of Object.entries(widths)) {
  classified.getRange(`${column}:${column}`).format.columnWidth = width;
}
classified.getRange("1:1").format.rowHeight = 30;
classified.getRange("2:2").format.rowHeight = 26;
classified.getRange("3:3").format.rowHeight = 32;
classified.freezePanes.freezeRows(3);
classified.freezePanes.freezeColumns(5);

const lastDataRow = classifiedRows.length + 3;
classified.getRange(`A4:A${lastDataRow}`).dataValidation = {
  rule: { type: "list", values: groups },
};
classified.getRange(`B4:B${lastDataRow}`).dataValidation = {
  rule: { type: "list", values: mainRelations },
};
classified.getRange(`C4:C${lastDataRow}`).dataValidation = {
  rule: { type: "list", values: testTypes },
};
classified.getRange(`D4:D${lastDataRow}`).dataValidation = {
  rule: { type: "list", values: priorities },
};

classified.getRange(`D4:D${lastDataRow}`).conditionalFormats.add("containsText", {
  text: "P0",
  format: { fill: "#FDE8E7", font: { color: "#B42318", bold: true } },
});
classified.getRange(`D4:D${lastDataRow}`).conditionalFormats.add("containsText", {
  text: "P1",
  format: { fill: "#FFF1D6", font: { color: "#9A5B00", bold: true } },
});
classified.getRange(`D4:D${lastDataRow}`).conditionalFormats.add("containsText", {
  text: "P2",
  format: { fill: "#E7F4EA", font: { color: "#176B3A", bold: true } },
});

const summary = workbook.worksheets.add("Tổng quan");
summary.showGridLines = false;
summary.getRange("A1:H1").merge();
summary.getRange("A1").values = [["INNOTRIK — TỔNG QUAN PHÂN LOẠI TEST CASE"]];
summary.getRange("A2:H2").merge();
summary.getRange("A2").values = [[
  "Bản phân loại hỗ trợ lọc riêng Button Main, các luồng được khởi tạo từ Main và những chức năng độc lập.",
]];

summary.getRange("A4:B4").merge();
summary.getRange("C4:D4").merge();
summary.getRange("E4:F4").merge();
summary.getRange("G4:H4").merge();
summary.getRange("A4").values = [["TỔNG TEST CASE"]];
summary.getRange("C4").values = [["MAIN - TRỰC TIẾP"]];
summary.getRange("E4").values = [["LUỒNG SAU MAIN"]];
summary.getRange("G4").values = [["NHÓM CHỨC NĂNG"]];
summary.getRange("A5:B5").merge();
summary.getRange("C5:D5").merge();
summary.getRange("E5:F5").merge();
summary.getRange("G5:H5").merge();
summary.getRange("A5").formulas = [[`=COUNTA('Phân loại'!$E$4:$E$${lastDataRow})`]];
summary.getRange("C5").formulas = [[`=COUNTIF('Phân loại'!$B$4:$B$${lastDataRow},"Main - trực tiếp")`]];
summary.getRange("E5").formulas = [[`=COUNTIF('Phân loại'!$B$4:$B$${lastDataRow},"Luồng sau Main")`]];
summary.getRange("G5").values = [[groups.length]];

const cardLabelRanges = ["A4:B4", "C4:D4", "E4:F4", "G4:H4"];
const cardValueRanges = ["A5:B5", "C5:D5", "E5:F5", "G5:H5"];
for (const range of cardLabelRanges) {
  summary.getRange(range).format = {
    fill: "#DCE8FF",
    font: { bold: true, color: "#244A9B", size: 10 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: "#B7C9EA" },
  };
}
for (const range of cardValueRanges) {
  summary.getRange(range).format = {
    fill: "#F7FAFF",
    font: { bold: true, color: "#12325B", size: 20 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: "#B7C9EA" },
  };
}

summary.getRange("A8:B8").values = [["Theo nhóm chức năng", "Số lượng"]];
summary.getRange(`A9:A${8 + groups.length}`).values = groups.map((value) => [value]);
summary.getRange(`B9:B${8 + groups.length}`).formulas = groups.map((_, index) => [
  `=COUNTIF('Phân loại'!$A$4:$A$${lastDataRow},A${9 + index})`,
]);

summary.getRange("D8:E8").values = [["Liên quan Button Main", "Số lượng"]];
summary.getRange(`D9:D${8 + mainRelations.length}`).values = mainRelations.map((value) => [value]);
summary.getRange(`E9:E${8 + mainRelations.length}`).formulas = mainRelations.map((_, index) => [
  `=COUNTIF('Phân loại'!$B$4:$B$${lastDataRow},D${9 + index})`,
]);

summary.getRange("G8:H8").values = [["Ưu tiên", "Số lượng"]];
summary.getRange(`G9:G${8 + priorities.length}`).values = priorities.map((value) => [value]);
summary.getRange(`H9:H${8 + priorities.length}`).formulas = priorities.map((_, index) => [
  `=COUNTIF('Phân loại'!$D$4:$D$${lastDataRow},G${9 + index})`,
]);

summary.getRange("D15:E15").values = [["Loại kiểm thử", "Số lượng"]];
summary.getRange(`D16:D${15 + testTypes.length}`).values = testTypes.map((value) => [value]);
summary.getRange(`E16:E${15 + testTypes.length}`).formulas = testTypes.map((_, index) => [
  `=COUNTIF('Phân loại'!$C$4:$C$${lastDataRow},D${16 + index})`,
]);

for (const headerRange of ["A8:B8", "D8:E8", "G8:H8", "D15:E15"]) {
  summary.getRange(headerRange).format = {
    fill: "#2F5BD3",
    font: { bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
}

for (const bodyRange of [
  `A9:B${8 + groups.length}`,
  `D9:E${8 + mainRelations.length}`,
  `G9:H${8 + priorities.length}`,
  `D16:E${15 + testTypes.length}`,
]) {
  summary.getRange(bodyRange).format = {
    fill: "#F8FAFD",
    font: { color: "#26364A", size: 10 },
    borders: {
      insideHorizontal: { style: "thin", color: "#D9E2F2" },
      bottom: { style: "thin", color: "#B7C9EA" },
    },
    verticalAlignment: "center",
  };
}

summary.getRange("A27:H28").merge();
summary.getRange("A27").values = [[
  "Cách đọc: “Main - trực tiếp” là test thao tác hoặc trạng thái của nút Main; “Luồng sau Main” là test chức năng được khởi tạo từ trợ lý; “Ngoài Button Main” là test độc lập; “MAIN phần cứng” là tín hiệu MAIN của thiết bị H20.",
]];
summary.getRange("A27:H28").format = {
  fill: "#FFF7E6",
  font: { color: "#7A4B00", italic: true, size: 10 },
  wrapText: true,
  verticalAlignment: "center",
  borders: { preset: "outside", style: "thin", color: "#E7C97A" },
};

summary.getRange("A1:H1").format = {
  fill: "#12325B",
  font: { bold: true, color: "#FFFFFF", size: 18 },
  horizontalAlignment: "left",
  verticalAlignment: "center",
};
summary.getRange("A2:H2").format = {
  fill: "#EAF2FF",
  font: { italic: true, color: "#46607F", size: 10 },
  verticalAlignment: "center",
};
for (const column of ["A", "C", "D", "F", "G"]) {
  summary.getRange(`${column}:${column}`).format.columnWidth = 24;
}
for (const column of ["B", "E", "H"]) {
  summary.getRange(`${column}:${column}`).format.columnWidth = 12;
}
summary.getRange("1:1").format.rowHeight = 32;
summary.getRange("2:2").format.rowHeight = 26;
summary.getRange("4:4").format.rowHeight = 24;
summary.getRange("5:5").format.rowHeight = 38;
summary.freezePanes.freezeRows(2);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

for (const sheetName of ["Test Cases", "Phân loại", "Tổng quan"]) {
  const preview = await workbook.render({
    sheetName,
    autoCrop: "all",
    scale: sheetName === "Test Cases" ? 0.8 : 1,
    format: "png",
  });
  const safeName = sheetName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "-").toLowerCase();
  await fs.writeFile(
    path.join(previewDir, `${safeName}.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
}

const keyCheck = await workbook.inspect({
  kind: "table",
  range: "Tổng quan!A1:H28",
  include: "values,formulas",
  tableMaxRows: 28,
  tableMaxCols: 8,
  maxChars: 12000,
});
console.log("===== SUMMARY_CHECK =====");
console.log(keyCheck.ndjson);

const classificationCheck = await workbook.inspect({
  kind: "table",
  range: "Phân loại!A1:J15",
  include: "values,formulas",
  tableMaxRows: 15,
  tableMaxCols: 10,
  maxChars: 12000,
});
console.log("===== CLASSIFICATION_CHECK =====");
console.log(classificationCheck.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "Final formula error scan",
});
console.log("===== FORMULA_ERRORS =====");
console.log(errors.ndjson);
