import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const sourcePath = "D:/Code/HuaMei/App_noi/be/9_10th8/speaking-ai-nextjs-backend/outputs/xlsx-dynamic-cost/trien-khai-model-ai-chi-phi-tu-dong.xlsx";
const workspace = "D:/Code/HuaMei/App_noi/be/9_10th8/speaking-ai-nextjs-backend";
const tempDir = `${workspace}/.codex-tmp/xlsx-dynamic-cost`;
const outputDir = `${workspace}/outputs/xlsx-single-sheet`;
const outputPath = `${outputDir}/trien-khai-model-ai-mot-sheet.xlsx`;

await fs.mkdir(outputDir, { recursive: true });

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(sourcePath));
const report = workbook.worksheets.getItem("Trang tính2");

// Tất cả biến đầu vào đều nằm trên chính sheet báo cáo.
const minutesCell = "$E$2";
const daysCell = "$B$121";
const fxCell = "$B$122";
const neuronsPerMinuteCell = "$B$125";
const freeQuotaCell = "$B$126";
const workersPaidCell = "$B$127";
const overageCell = "$B$128";
const vertexHourlyCell = "$B$131";
const vertexHoursCell = "$B$132";
const optimisticCapacityCell = "$B$133";
const conservativeCapacityCell = "$B$134";

function cloudCostFormula(userRef) {
  const dailyNeurons = `${userRef}*${minutesCell}*${neuronsPerMinuteCell}`;
  return `=IF(${dailyNeurons}<=${freeQuotaCell},0,${workersPaidCell}+(${dailyNeurons}-${freeQuotaCell})*${daysCell}*${overageCell}/1000)`;
}

function minReplicas(minutesMonthRef) {
  return `MAX(1,ROUNDUP(${minutesMonthRef}/60/${optimisticCapacityCell},0))`;
}

function maxReplicas(minutesMonthRef) {
  return `MAX(1,ROUNDUP(${minutesMonthRef}/60/${conservativeCapacityCell},0))`;
}

function vertexReplicaFormula(minutesMonthRef) {
  const low = minReplicas(minutesMonthRef);
  const high = maxReplicas(minutesMonthRef);
  return `=IF(${low}=${high},TEXT(${low},"0"),TEXT(${low},"0")&"-"&TEXT(${high},"0"))`;
}

function vertexUsdFormula(minutesMonthRef) {
  const low = minReplicas(minutesMonthRef);
  const high = maxReplicas(minutesMonthRef);
  const monthly = `${vertexHourlyCell}*${vertexHoursCell}`;
  return `=IF(${low}=${high},TEXT(${low}*${monthly},"$#,##0.00"),TEXT(${low}*${monthly},"#,##0.00")&"–"&TEXT(${high}*${monthly},"#,##0.00"))`;
}

function vertexVndFormula(minutesMonthRef) {
  const low = minReplicas(minutesMonthRef);
  const high = maxReplicas(minutesMonthRef);
  const monthlyVnd = `${vertexHourlyCell}*${vertexHoursCell}*${fxCell}`;
  return `=IF(${low}=${high},TEXT(${low}*${monthlyVnd}/1000000,"0.00")&" triệu",TEXT(${low}*${monthlyVnd}/1000000,"0.00")&"–"&TEXT(${high}*${monthlyVnd}/1000000,"0.00")&" triệu")`;
}

// Ô nhập chính nằm ngay đầu báo cáo, dễ nhìn và luôn cùng sheet với kết quả.
report.getRange("A2:E2").unmerge();
report.getRange("A2:D2").merge();
report.getRange("A2").values = [["PHÚT SỬ DỤNG MỖI NGÀY / 每天使用分钟数\nThay ô màu vàng bên phải để tính lại toàn bộ chi phí / 修改右侧黄色单元格以重新计算全部成本"]];
report.getRange("E2").values = [[10]];
report.getRange("A2:D2").format = {
  fill: "#EAF2F8",
  font: { typeface: "Arial", bold: true, color: "#17365D", fontSize: 10 },
  wrapText: true,
  verticalAlignment: "center",
  horizontalAlignment: "left",
  borders: { preset: "all", style: "thin", color: "#9FBAD0" },
};
report.getRange("E2").format = {
  fill: "#FFF2CC",
  font: { typeface: "Arial", bold: true, color: "#9C6500", fontSize: 14 },
  numberFormat: "0 \"phút\"",
  horizontalAlignment: "center",
  verticalAlignment: "center",
  borders: { preset: "all", style: "medium", color: "#BF9000" },
};
report.getRange("A2:E2").format.rowHeight = 48;
report.getRange("E2").dataValidation = {
  rule: { type: "whole", operator: "between", formula1: 0, formula2: 1440 },
};
report.freezePanes.unfreeze();
report.freezePanes.freezeRows(2);

// Khối giả định được đưa xuống cuối báo cáo để workbook chỉ còn một sheet.
report.getRange("A119:E119").merge();
report.getRange("A119").values = [["CẤU HÌNH VÀ GIẢ ĐỊNH / 配置与假设"]];
report.getRange("A120:E120").merge();
report.getRange("A120").values = [["Ô nhập thường dùng nằm ở E2. Các tham số dưới đây giữ nguyên từ báo cáo hiện tại và có thể chỉnh khi cần.\n常用输入位于 E2。以下参数沿用当前报告，必要时可以修改。"]];

for (const row of [121, 122, 125, 126, 127, 128, 131, 132, 133, 134]) {
  report.getRange(`C${row}:E${row}`).merge();
}

report.getRange("A121:B122").values = [
  ["Số ngày/tháng / 每月天数", 30],
  ["Tỷ giá VND/USD / 越南盾/美元汇率", 26000],
];
report.getRange("C121").values = [["Giả định thời gian / 时间假设"]];
report.getRange("C122").values = [["Dùng để quy đổi VND / 用于换算越南盾"]];

report.getRange("A124:E124").merge();
report.getRange("A124").values = [["CLOUDFLARE WORKERS AI — GIẢ ĐỊNH / 假设"]];
report.getRange("A125:B128").values = [
  ["Neurons/phút audio / 每分钟音频 Neurons", 46.63],
  ["Quota miễn phí/ngày / 每日免费额度", 10000],
  ["Workers Paid tối thiểu/tháng / 最低月费", 5],
  ["Phí vượt quota / 超额费用", 0.011],
];
report.getRange("C125").values = [["Theo số liệu đang dùng trong báo cáo / 沿用当前报告参数"]];
report.getRange("C126").values = [["Neurons/ngày / Neurons/天"]];
report.getRange("C127").values = [["USD; chỉ cộng khi vượt quota ngày / 超过每日额度时计入"]];
report.getRange("C128").values = [["USD/1.000 Neurons"]];

report.getRange("A130:E130").merge();
report.getRange("A130").values = [["VERTEX AI CUSTOM ENDPOINT — GIẢ ĐỊNH / 假设"]];
report.getRange("A131:B134").values = [
  ["Chi phí/giờ/replica / 每小时每副本成本", 0.621],
  ["Số giờ chạy/tháng / 每月运行小时", 730],
  ["Công suất lạc quan / 乐观容量", 5000],
  ["Công suất thận trọng / 保守容量", 2500],
];
report.getRange("C131").values = [["USD/giờ / 美元/小时"]];
report.getRange("C132").values = [["Replica warm chạy 24/7 / 热副本全天候运行"]];
report.getRange("C133").values = [["Giờ audio/tháng/replica / 音频小时/月/副本"]];
report.getRange("C134").values = [["Giờ audio/tháng/replica / 音频小时/月/副本"]];

report.getRange("A136:E136").merge();
report.getRange("A136").values = [["Ví dụ: đổi E2 từ 10 thành 12. Phút/tháng, giờ audio, số replica, chi phí USD và VND sẽ cập nhật tự động.\n示例：将 E2 从 10 改为 12。每月分钟、音频小时、副本数量、美元和越南盾成本都会自动更新。"]];

report.getRange("A119:E119").format = {
  fill: "#3C78D8",
  font: { typeface: "Arial", bold: true, color: "#FFFFFF", fontSize: 13 },
  horizontalAlignment: "center",
  verticalAlignment: "center",
};
report.getRange("A120:E120").format = {
  fill: "#EAF2F8",
  font: { typeface: "Arial", color: "#17365D", fontSize: 9 },
  wrapText: true,
  verticalAlignment: "center",
};
for (const section of ["A124:E124", "A130:E130"]) {
  report.getRange(section).format = {
    fill: "#D9EAD3",
    font: { typeface: "Arial", bold: true, color: "#17365D" },
    verticalAlignment: "center",
  };
}
for (const block of ["A121:E122", "A125:E128", "A131:E134"]) {
  report.getRange(block).format.borders = { preset: "all", style: "thin", color: "#C9D4E2" };
  report.getRange(block).format.verticalAlignment = "center";
  report.getRange(block).format.wrapText = true;
}
report.getRange("A119:E136").format.font = { typeface: "Arial" };
report.getRange("B121:B134").format.horizontalAlignment = "center";
report.getRange("B121:B134").format.fill = "#F3F8FC";
report.getRange("B121").format.numberFormat = "0";
report.getRange("B122").format.numberFormat = "#,##0";
report.getRange("B125").format.numberFormat = "0.00";
report.getRange("B126").format.numberFormat = "#,##0";
report.getRange("B127").format.numberFormat = "$#,##0.00";
report.getRange("B128").format.numberFormat = "$0.000";
report.getRange("B131").format.numberFormat = "$0.000";
report.getRange("B132:B134").format.numberFormat = "#,##0";
report.getRange("A136:E136").format = {
  fill: "#F8FAFC",
  font: { typeface: "Arial", italic: true, color: "#475569", fontSize: 9 },
  wrapText: true,
  verticalAlignment: "center",
  borders: { preset: "outside", style: "thin", color: "#C9D4E2" },
};
report.getRange("A119:E119").format.rowHeight = 32;
report.getRange("A120:E120").format.rowHeight = 42;
report.getRange("A124:E124").format.rowHeight = 26;
report.getRange("A130:E130").format.rowHeight = 26;
report.getRange("A121:E134").format.rowHeight = 24;
report.getRange("A136:E136").format.rowHeight = 42;

// Bảng tổng hợp ở đầu báo cáo.
report.getRange("C6").formulas = [[`=B6*${minutesCell}*${daysCell}`]];
report.getRange("C6:C19").fillDown();
report.getRange("D6").formulas = [[cloudCostFormula("B6")]];
report.getRange("D6:D12").fillDown();
report.getRange("E6").formulas = [[`=D6*${fxCell}`]];
report.getRange("E6:E12").fillDown();
report.getRange("D13").formulas = [[vertexUsdFormula("C13")]];
report.getRange("D13:D19").fillDown();
report.getRange("E13").formulas = [[vertexVndFormula("C13")]];
report.getRange("E13:E19").fillDown();

// Mô tả và bảng chi tiết Cloudflare.
report.getRange("A25").formulas = [[`="Mỗi user dùng "&TEXT(${minutesCell}*${neuronsPerMinuteCell},"0.0")&" Neurons/ngày."`]];
report.getRange("A26").formulas = [[`="每位用户每天使用 "&TEXT(${minutesCell}*${neuronsPerMinuteCell},"0.0")&" Neurons。"`]];
report.getRange("A27").formulas = [[`="Chi phí AI tháng = max(0; "&TEXT(${minutesCell}*${neuronsPerMinuteCell},"0.0")&" x số user - "&TEXT(${freeQuotaCell},"#,##0")&") x "&TEXT(${daysCell},"0")&" x "&TEXT(${overageCell},"0.000")&" / 1.000."`]];
report.getRange("A28").formulas = [[`="每月 AI 成本 = max(0；"&TEXT(${minutesCell}*${neuronsPerMinuteCell},"0.0")&" × 用户数 - "&TEXT(${freeQuotaCell},"#,##0")&") × "&TEXT(${daysCell},"0")&" × "&TEXT(${overageCell},"0.000")&" / 1,000。"`]];
report.getRange("A29").formulas = [[`="Khi vượt quota ngày, cộng tối thiểu "&TEXT(${workersPaidCell},"0.00")&" USD/tháng cho Workers Paid."`]];
report.getRange("A30").formulas = [[`="当每日用量超过免费额度时，需要至少支付每月 "&TEXT(${workersPaidCell},"0.00")&" 美元的 Workers Paid 套餐费。"`]];
report.getRange("A31").formulas = [[`="Nếu vượt quota Workers Paid, AI được tính riêng ở mức $"&TEXT(${overageCell},"0.000")&"/1.000 Neurons."`]];
report.getRange("A32").formulas = [[`="使用 Workers Paid 后，超出免费额度的 AI 用量按每 1,000 Neurons "&TEXT(${overageCell},"0.000")&" 美元另行计费。"`]];
report.getRange("B35").formulas = [[`=A35*${minutesCell}*${daysCell}`]];
report.getRange("B35:B41").fillDown();
report.getRange("C35").formulas = [[cloudCostFormula("A35")]];
report.getRange("C35:C41").fillDown();
report.getRange("D35").formulas = [[`=C35*${fxCell}`]];
report.getRange("D35:D41").fillDown();

// Mô tả và bảng chi tiết Vertex AI.
report.getRange("A50").formulas = [[`="Tổng 1 replica(máy chủ): "&TEXT(${vertexHourlyCell},"0.000")&" USD/giờ."`]];
report.getRange("A51").formulas = [[`="1 个副本（服务器）的总成本：每小时 "&TEXT(${vertexHourlyCell},"0.000")&" 美元。"`]];
report.getRange("A52").formulas = [[`="1 replica(máy chủ) chạy 24/7 = "&TEXT(${vertexHourlyCell}*${vertexHoursCell},"#,##0.00")&" USD/tháng."`]];
report.getRange("A53").formulas = [[`="1 个副本（服务器）全天候运行 = 每月 "&TEXT(${vertexHourlyCell}*${vertexHoursCell},"#,##0.00")&" 美元。"`]];
report.getRange("B56").formulas = [[`=A56*${minutesCell}*${daysCell}/60`]];
report.getRange("B56:B62").fillDown();
report.getRange("C56").formulas = [[vertexReplicaFormula(`A56*${minutesCell}*${daysCell}`)]];
report.getRange("C56:C62").fillDown();
report.getRange("D56").formulas = [[vertexUsdFormula(`A56*${minutesCell}*${daysCell}`)]];
report.getRange("D56:D62").fillDown();

// Kịch bản chạy thử một tuần.
report.getRange("A102").formulas = [[`="Theo đơn giá trong báo cáo, chi phí của 1 replica là "&TEXT(${vertexHourlyCell},"0.000")&" USD/giờ."`]];
report.getRange("A103").formulas = [[`="根据报告中的单价，1 个副本的费用为 "&TEXT(${vertexHourlyCell},"0.000")&" 美元/小时。"`]];
report.getRange("A104").formulas = [[`="Chi phí chạy liên tục trong 7 ngày: "&TEXT(${vertexHourlyCell}*24*7,"#,##0.00")&" USD."`]];
report.getRange("A105").formulas = [[`="连续运行 7 天的费用："&TEXT(${vertexHourlyCell}*24*7,"#,##0.00")&" 美元。"`]];

// Xóa hai sheet phụ sau khi mọi tham chiếu đã chuyển sang cùng sheet.
workbook.worksheets.getItem("Trang tính1").delete();
workbook.worksheets.getItem("Cấu hình").delete();

for (const scenario of [10, 12]) {
  report.getRange("E2").values = [[scenario]];
  const check = await workbook.inspect({
    kind: "table",
    sheetId: "Trang tính2",
    range: "B5:E19",
    include: "values,formulas",
    tableMaxRows: 20,
    tableMaxCols: 6,
    tableMaxCellChars: 160,
    maxChars: 12000,
  });
  console.log(`SCENARIO_${scenario}`);
  console.log(check.ndjson);
}
report.getRange("E2").values = [[10]];

const sheetCheck = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 3000 });
console.log("SHEET_CHECK");
console.log(sheetCheck.ndjson);

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "single-sheet formula error scan",
});
console.log("FORMULA_ERROR_SCAN");
console.log(formulaErrors.ndjson);

const fullPreview = await workbook.render({ sheetName: "Trang tính2", autoCrop: "all", scale: 1.1, format: "png" });
await fs.writeFile(`${tempDir}/single-sheet-full.png`, new Uint8Array(await fullPreview.arrayBuffer()));
const topPreview = await workbook.render({ sheetName: "Trang tính2", range: "A1:E20", scale: 1.5, format: "png" });
await fs.writeFile(`${tempDir}/single-sheet-top.png`, new Uint8Array(await topPreview.arrayBuffer()));
const configPreview = await workbook.render({ sheetName: "Trang tính2", range: "A119:E136", scale: 1.4, format: "png" });
await fs.writeFile(`${tempDir}/single-sheet-config.png`, new Uint8Array(await configPreview.arrayBuffer()));

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(`OUTPUT_PATH=${outputPath}`);
