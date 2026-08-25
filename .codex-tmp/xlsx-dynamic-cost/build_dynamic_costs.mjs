import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "C:/Users/DELL/Downloads/Triển khai Model AI.xlsx";
const workspace = "D:/Code/HuaMei/App_noi/be/9_10th8/speaking-ai-nextjs-backend";
const previewDir = `${workspace}/.codex-tmp/xlsx-dynamic-cost`;
const outputDir = `${workspace}/outputs/xlsx-dynamic-cost`;
const outputPath = `${outputDir}/trien-khai-model-ai-chi-phi-tu-dong.xlsx`;

await fs.mkdir(outputDir, { recursive: true });

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const simple = workbook.worksheets.getItem("Trang tính1");
const report = workbook.worksheets.getItem("Trang tính2");
const config = workbook.worksheets.add("Cấu hình");

const cfg = (cell) => `'Cấu hình'!$${cell}`;
const minutesCell = cfg("B$3");
const daysCell = cfg("B$4");
const fxCell = cfg("B$5");
const neuronsPerMinuteCell = cfg("B$8");
const freeQuotaCell = cfg("B$9");
const workersPaidCell = cfg("B$10");
const overageCell = cfg("B$11");
const vertexHourlyCell = cfg("B$14");
const vertexHoursCell = cfg("B$15");
const optimisticCapacityCell = cfg("B$16");
const conservativeCapacityCell = cfg("B$17");

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

// Cấu hình tập trung: người dùng chỉ cần thay ô B3 để toàn bộ báo cáo cập nhật.
config.showGridLines = false;
config.getRange("A1:C1").merge();
config.getRange("A1").values = [["CẤU HÌNH TÍNH CHI PHÍ / 成本计算设置"]];
config.getRange("A2:C2").merge();
config.getRange("A2").values = [["Chỉ cần đổi ô B3 (phút/ngày/người dùng). Các bảng Cloudflare và Vertex AI sẽ tự tính lại.\n只需修改 B3（每位用户每天分钟数），Cloudflare 和 Vertex AI 成本表会自动更新。"]];
config.getRange("A3:C5").values = [
  ["Phút/ngày/người dùng / 每位用户每天分钟数", 10, "Ô nhập chính / 主要输入"],
  ["Số ngày/tháng / 每月天数", 30, "Giả định thời gian / 时间假设"],
  ["Tỷ giá VND/USD / 越南盾/美元汇率", 26000, "Dùng để quy đổi VND / 用于换算越南盾"],
];
config.getRange("A7:C7").merge();
config.getRange("A7").values = [["CLOUDFLARE WORKERS AI — GIẢ ĐỊNH / 假设"]];
config.getRange("A8:C11").values = [
  ["Neurons/phút audio / 每分钟音频 Neurons", 46.63, "Theo số liệu đang dùng trong báo cáo gốc / 沿用原报告参数"],
  ["Quota miễn phí/ngày / 每日免费额度", 10000, "Neurons/ngày / Neurons/天"],
  ["Workers Paid tối thiểu/tháng / 最低月费", 5, "USD; chỉ cộng khi vượt quota ngày / 超过每日额度时计入"],
  ["Phí vượt quota / 超额费用", 0.011, "USD/1.000 Neurons"],
];
config.getRange("A13:C13").merge();
config.getRange("A13").values = [["VERTEX AI CUSTOM ENDPOINT — GIẢ ĐỊNH / 假设"]];
config.getRange("A14:C17").values = [
  ["Chi phí/giờ/replica / 每小时每副本成本", 0.621, "USD/giờ / 美元/小时"],
  ["Số giờ chạy/tháng / 每月运行小时", 730, "Replica warm chạy 24/7 / 热副本全天候运行"],
  ["Công suất lạc quan / 乐观容量", 5000, "Giờ audio/tháng/replica / 音频小时/月/副本"],
  ["Công suất thận trọng / 保守容量", 2500, "Giờ audio/tháng/replica / 音频小时/月/副本"],
];
config.getRange("A19:C21").merge(true);
config.getRange("A19:C21").values = [
  ["Cách dùng / 使用方法", null, null],
  ["Ví dụ: đổi B3 từ 10 thành 12. Phút/tháng, giờ audio, chi phí USD và quy đổi VND sẽ cập nhật tự động.", null, null],
  ["示例：将 B3 从 10 改为 12。每月分钟数、音频小时数、美元成本和越南盾换算都会自动更新。", null, null],
];

config.getRange("A1:C1").format = {
  fill: "#3C78D8",
  font: { bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
};
config.getRange("A2:C2").format = {
  fill: "#EAF2F8",
  font: { color: "#17365D" },
  wrapText: true,
  verticalAlignment: "center",
};
for (const section of ["A7:C7", "A13:C13", "A19:C19"]) {
  config.getRange(section).format = {
    fill: "#D9EAD3",
    font: { bold: true, color: "#17365D" },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
}
for (const block of ["A3:C5", "A8:C11", "A14:C17", "A19:C21"]) {
  config.getRange(block).format.borders = { preset: "all", style: "thin", color: "#C9D4E2" };
  config.getRange(block).format.verticalAlignment = "center";
}
config.getRange("A3:C21").format.wrapText = true;
config.getRange("B3").format = {
  fill: "#FFF2CC",
  font: { bold: true, color: "#9C6500" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  numberFormat: "0",
  borders: { preset: "all", style: "medium", color: "#BF9000" },
};
config.getRange("B4:B17").format.horizontalAlignment = "center";
config.getRange("B4:B17").format.fill = "#F3F8FC";
config.getRange("B5").format.numberFormat = "#,##0";
config.getRange("B8").format.numberFormat = "0.00";
config.getRange("B9").format.numberFormat = "#,##0";
config.getRange("B10").format.numberFormat = "$#,##0.00";
config.getRange("B11").format.numberFormat = "$0.000";
config.getRange("B14").format.numberFormat = "$0.000";
config.getRange("B15:B17").format.numberFormat = "#,##0";
config.getRange("A1:C21").format.font = { typeface: "Arial" };
config.getRange("A1:C1").format.font = { typeface: "Arial", bold: true, color: "#FFFFFF", fontSize: 15 };
config.getRange("A2:C2").format.font = { typeface: "Arial", color: "#17365D", fontSize: 10 };
config.getRange("B3").format.font = { typeface: "Arial", bold: true, color: "#9C6500", fontSize: 12 };
config.getRange("A1:C21").format.rowHeight = 24;
config.getRange("A1:C1").format.rowHeight = 34;
config.getRange("A2:C2").format.rowHeight = 52;
config.getRange("A19:C19").format.rowHeight = 28;
config.getRange("A20:C21").format.rowHeight = 36;
config.getRange("A:A").format.columnWidth = 54;
config.getRange("B:B").format.columnWidth = 18;
config.getRange("C:C").format.columnWidth = 55;
config.freezePanes.freezeRows(2);
config.getRange("B3").dataValidation = {
  rule: { type: "whole", operator: "between", formula1: 0, formula2: 1440 },
};

// Báo cáo chính: tiêu đề và bảng tổng hợp.
report.getRange("A2").formulas = [[`="Chi phí khi mỗi người dùng nói và sử dụng trợ lí "&${minutesCell}&" phút mỗi ngày (đổi tại Cấu hình!B3)"&CHAR(10)&"每位用户每天使用助手 "&${minutesCell}&" 分钟的费用（在 Cấu hình!B3 修改）。"`]];
report.getRange("C6").formulas = [[`=B6*${minutesCell}*${daysCell}`]];
report.getRange("C6:C19").fillDown();
report.getRange("D6").formulas = [[cloudCostFormula("B6")]];
report.getRange("D6:D12").fillDown();
report.getRange("E6").formulas = [["=D6*" + fxCell]];
report.getRange("E6:E12").fillDown();
report.getRange("D13").formulas = [[vertexUsdFormula("C13")]];
report.getRange("D13:D19").fillDown();
report.getRange("E13").formulas = [[vertexVndFormula("C13")]];
report.getRange("E13:E19").fillDown();
report.getRange("C6:C19").format.numberFormat = "#,##0";
report.getRange("D6:D12").format.numberFormat = "$#,##0.00";
report.getRange("E6:E12").format.numberFormat = "#,##0 \"đ\"";
report.getRange("A2:E2").format.wrapText = true;
report.getRange("A2:E2").format.rowHeight = 46;
report.getRange("D:D").format.columnWidth = 20;
report.getRange("E:E").format.columnWidth = 23;

// Cloudflare: mô tả và bảng chi tiết đều liên kết với ô phút/ngày.
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
report.getRange("D35").formulas = [["=C35*" + fxCell]];
report.getRange("D35:D41").fillDown();
report.getRange("B35:B41").format.numberFormat = "#,##0";
report.getRange("C35:C41").format.numberFormat = "$#,##0.00";
report.getRange("D35:D41").format.numberFormat = "#,##0 \"đ\"";

// Vertex AI: số giờ audio, số replica và chi phí được tính theo cùng biến đầu vào.
report.getRange("A50").formulas = [[`="Tổng 1 replica(máy chủ): "&TEXT(${vertexHourlyCell},"0.000")&" USD/giờ."`]];
report.getRange("A51").formulas = [[`="1 个副本（服务器）的总成本：每小时 "&TEXT(${vertexHourlyCell},"0.000")&" 美元。"`]];
report.getRange("A52").formulas = [[`="1 replica(máy chủ) chạy 24/7 = "&TEXT(${vertexHourlyCell}*${vertexHoursCell},"#,##0.00")&" USD/tháng."`]];
report.getRange("A53").formulas = [[`="1 个副本（服务器）全天候运行 = 每月 "&TEXT(${vertexHourlyCell}*${vertexHoursCell},"#,##0.00")&" 美元。"`]];
report.getRange("B56").formulas = [[`=A56*${minutesCell}*${daysCell}/60`]];
report.getRange("B56:B62").fillDown();
report.getRange("C56").formulas = [[vertexReplicaFormula("A56*" + minutesCell + "*" + daysCell)]];
report.getRange("C56:C62").fillDown();
report.getRange("D56").formulas = [[vertexUsdFormula("A56*" + minutesCell + "*" + daysCell)]];
report.getRange("D56:D62").fillDown();
report.getRange("B56:B62").format.numberFormat = "#,##0.0";
report.getRange("C56:C62").format.numberFormat = "@";

// Kịch bản thử nghiệm 7 ngày cũng được liên kết với đơn giá Vertex AI.
report.getRange("A102").formulas = [[`="Theo đơn giá trong báo cáo, chi phí của 1 replica là "&TEXT(${vertexHourlyCell},"0.000")&" USD/giờ."`]];
report.getRange("A103").formulas = [[`="根据报告中的单价，1 个副本的费用为 "&TEXT(${vertexHourlyCell},"0.000")&" 美元/小时。"`]];
report.getRange("A104").formulas = [[`="Chi phí chạy liên tục trong 7 ngày: "&TEXT(${vertexHourlyCell}*24*7,"#,##0.00")&" USD."`]];
report.getRange("A105").formulas = [[`="连续运行 7 天的费用："&TEXT(${vertexHourlyCell}*24*7,"#,##0.00")&" 美元。"`]];

// Trang tóm tắt cũ vẫn giữ bố cục, nhưng mọi số liệu được thay bằng công thức.
simple.getRange("C2").formulas = [[`=B2*${minutesCell}*${daysCell}`]];
simple.getRange("C2:C5").fillDown();
simple.getRange("D2").formulas = [[cloudCostFormula("B2")]];
simple.getRange("D2:D5").fillDown();
simple.getRange("E2").formulas = [["=D2*" + fxCell]];
simple.getRange("E2:E5").fillDown();
simple.getRange("C7").formulas = [[`=B7*${minutesCell}*${daysCell}`]];
simple.getRange("C7:C10").fillDown();
simple.getRange("D7").formulas = [[vertexUsdFormula("C7")]];
simple.getRange("D7:D10").fillDown();
simple.getRange("E7").formulas = [[vertexVndFormula("C7")]];
simple.getRange("E7:E10").fillDown();
simple.getRange("C2:C5").format.numberFormat = "#,##0";
simple.getRange("D2:D5").format.numberFormat = "$#,##0.00";
simple.getRange("E2:E5").format.numberFormat = "#,##0 \"đ\"";
simple.getRange("C7:C10").format.numberFormat = "#,##0";
simple.getRange("D:D").format.columnWidth = 20;
simple.getRange("E:E").format.columnWidth = 25;

// Kiểm thử động ở 10 và 12 phút; sau đó trả về 10 phút làm giá trị mặc định ban đầu.
for (const scenario of [10, 12]) {
  config.getRange("B3").values = [[scenario]];
  const check = await workbook.inspect({
    kind: "table",
    sheetId: "Trang tính2",
    range: "B5:E19",
    include: "values,formulas",
    tableMaxRows: 20,
    tableMaxCols: 6,
    tableMaxCellChars: 180,
    maxChars: 14000,
  });
  console.log(`SCENARIO_${scenario}_MINUTES`);
  console.log(check.ndjson);
}
config.getRange("B3").values = [[10]];

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
console.log("FORMULA_ERROR_SCAN");
console.log(formulaErrors.ndjson);

const finalCheck = await workbook.inspect({
  kind: "table",
  sheetId: "Trang tính2",
  range: "A1:E19",
  include: "values,formulas",
  tableMaxRows: 20,
  tableMaxCols: 6,
  tableMaxCellChars: 220,
  maxChars: 16000,
});
console.log("FINAL_CHECK");
console.log(finalCheck.ndjson);

for (const [name, file] of [
  ["Trang tính1", "final-preview-1.png"],
  ["Trang tính2", "final-preview-2.png"],
  ["Cấu hình", "final-preview-3.png"],
]) {
  const preview = await workbook.render({ sheetName: name, autoCrop: "all", scale: 1.35, format: "png" });
  await fs.writeFile(`${previewDir}/${file}`, new Uint8Array(await preview.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(`OUTPUT_PATH=${outputPath}`);
