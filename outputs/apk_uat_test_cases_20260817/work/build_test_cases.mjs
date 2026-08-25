import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const rootDir = "D:/Code/HuaMei/App_noi/be/9_10th8/speaking-ai-nextjs-backend/outputs/apk_uat_test_cases_20260817";
const workDir = path.join(rootDir, "work");
const qaDir = path.join(rootDir, "qa");
const outputPath = path.join(rootDir, "AIV1_APK_Test_Cases_V1.0_20260817.xlsx");
const sourceJsonPath = path.join(workDir, "source_content.json");
const sourceDocx = "C:/Users/DELL/Downloads/AIV1_Danh_sach_nghiem_thu_thiet_bi_APK_Viet_Nam_truoc_lam_khuon_dat_hang (1).docx";

await fs.mkdir(qaDir, { recursive: true });
const source = JSON.parse(await fs.readFile(sourceJsonPath, "utf8"));

const workbook = Workbook.create();
const summarySheet = workbook.worksheets.add("Tong quan");
const configSheet = workbook.worksheets.add("Cau hinh");
const analysisSheet = workbook.worksheets.add("Phan tich");
const casesSheet = workbook.worksheets.add("Test Cases");
const traceSheet = workbook.worksheets.add("Truy vet");
const dataSheet = workbook.worksheets.add("Du lieu test");
const defectSheet = workbook.worksheets.add("Defect Log");

const colors = {
  navy: "#17365D",
  blue: "#1F4E78",
  teal: "#0F6B78",
  cyan: "#DDEBF7",
  paleBlue: "#EAF3F8",
  green: "#E2F0D9",
  greenText: "#2F641C",
  yellow: "#FFF2CC",
  orange: "#FCE4D6",
  red: "#F4CCCC",
  redText: "#9C0006",
  gray: "#E7E6E6",
  darkGray: "#595959",
  border: "#C9D2DC",
  white: "#FFFFFF",
};

const resultOptions = ["Chưa test", "Đạt", "Đạt có điều kiện", "Không đạt", "Không áp dụng (Tương lai)"];

function setTitle(sheet, rangeAddress, title, subtitleAddress, subtitle) {
  const titleRange = sheet.getRange(rangeAddress);
  titleRange.merge();
  titleRange.values = [[title]];
  titleRange.format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white, size: 18 },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  titleRange.format.rowHeight = 34;
  if (subtitleAddress && subtitle) {
    const subtitleRange = sheet.getRange(subtitleAddress);
    subtitleRange.merge();
    subtitleRange.values = [[subtitle]];
    subtitleRange.format = {
      fill: colors.paleBlue,
      font: { color: colors.darkGray, italic: true, size: 10 },
      wrapText: true,
      verticalAlignment: "center",
    };
    subtitleRange.format.rowHeight = 30;
  }
  sheet.showGridLines = false;
}

function setHeader(range) {
  range.format = {
    fill: colors.blue,
    font: { bold: true, color: colors.white, size: 10 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: colors.border },
  };
  range.format.rowHeight = 32;
}

function setBody(range, rowHeight = 48) {
  range.format = {
    font: { size: 9, color: "#1F1F1F" },
    verticalAlignment: "top",
    wrapText: true,
    borders: {
      insideHorizontal: { style: "thin", color: colors.border },
      bottom: { style: "thin", color: colors.border },
    },
  };
  range.format.rowHeight = rowHeight;
}

function setColumnWidth(sheet, column, width, lastRow) {
  sheet.getRange(`${column}1:${column}${lastRow}`).format.columnWidth = width;
}

const tableMeta = {
  4: { prefix: "EV", section: "0. Bằng chứng hiện có", module: "Bằng chứng & phạm vi" },
  5: { prefix: "GATE", section: "1. Cổng kiểm soát P0", module: "Go/No-Go P0" },
  6: { prefix: "SETUP", section: "2. A. Chuẩn bị, cài đặt và quyền", module: "Cài đặt & quyền" },
  7: { prefix: "BT", section: "3. B. Bluetooth, HFP, BLE và nút", module: "Bluetooth/HFP/BLE" },
  8: { prefix: "HW", section: "4. C. Phần cứng, sạc và âm thanh", module: "Phần cứng & an toàn" },
  9: { prefix: "MAIN", section: "5. D. MAIN và câu lệnh có kiểm soát", module: "MAIN/Voice command" },
  10: { prefix: "TRANS", section: "6. E. Dịch thời gian thực", module: "Dịch Việt-Anh" },
  11: { prefix: "LEARN", section: "7. F. Nội dung học", module: "Học theo chủ đề" },
  12: { prefix: "VOICE", section: "8. G. Giọng trẻ em và tiếng ồn", module: "Giọng trẻ/ASR/VAD" },
  13: { prefix: "COMP", section: "9. H. Tương thích và ổn định", module: "Tương thích/ổn định" },
  14: { prefix: "UX", section: "10. I. Trải nghiệm phụ huynh và trẻ", module: "Usability/UAT" },
  15: { prefix: "FUT", section: "11. J. Mức độ sẵn sàng tương lai", module: "Future readiness" },
  17: { prefix: "CLOSE", section: "12. Khép kín và quyết định", module: "Khép kín/Quyết định" },
};

function classifyType(req) {
  const text = `${req.title} ${req.criteria}`.toLowerCase();
  if (req.table === 4 || req.table === 15 || req.table === 17) return "Review/Process";
  if (text.includes("quyền riêng tư") || text.includes("đồng ý")) return "Privacy";
  if (text.includes("sạc") || text.includes("nhiệt") || text.includes("pin") || req.table === 8) return "Hardware/Safety";
  if (text.includes("độ trễ") || text.includes("tải") || text.includes("crash") || text.includes("bộ nhớ")) return "Performance/Reliability";
  if (req.table === 7 || text.includes("hfp") || text.includes("ble") || text.includes("bluetooth")) return "Integration";
  if (req.table === 12) return "Voice/Localization";
  if (req.table === 13) return "Compatibility";
  if (req.table === 14) return "Usability/UAT";
  return "Functional";
}

function platformFor(req) {
  const text = `${req.title} ${req.criteria}`.toLowerCase();
  if (req.table === 15 || req.table === 17 || req.table === 4) return "Tài liệu/Quy trình";
  if (req.table === 8) return "Thiết bị AIV1/H20";
  if (text.includes("iphone") || text.includes("android") || req.table === 13) return "Android + iOS (build tương ứng)";
  return "Android/iOS + thiết bị AIV1/H20";
}

function preconditionsFor(req) {
  const common = "Đã điền sheet Cấu hình; thiết bị mẫu, firmware và build ứng dụng được khóa phiên bản; thư mục bằng chứng đã tạo.";
  if (req.table === 4 || req.table === 15 || req.table === 17) return `${common} Có tài liệu/log/biên bản liên quan và người chịu trách nhiệm tham gia rà soát.`;
  if (req.table === 6) return `${common} Có thiết bị Android và/hoặc iPhone theo phạm vi; có thể cài mới và thay đổi quyền hệ thống.`;
  if (req.table === 7 || req.table === 5) return `${common} Thiết bị đã sạc; Bluetooth bật; có công cụ ghi màn hình, log BLE/GATT và đối chứng nguồn âm thanh.`;
  if (req.table === 8) return `${common} Có dây/củ sạc chuẩn, đồng hồ thời gian, phương tiện đo nhiệt nếu cần và khu vực thử an toàn.`;
  if (req.table === 9 || req.table === 10 || req.table === 11) return `${common} Thiết bị đã ghép HFP+BLE; tài khoản/phụ huynh đã thiết lập; mạng và dữ liệu test sẵn sàng.`;
  if (req.table === 12) return `${common} Có đồng ý hợp lệ; dữ liệu trẻ được mã hóa ẩn danh; mẫu vùng giọng và môi trường đã chuẩn bị.`;
  if (req.table === 14) return `${common} Có người giám sát; phụ huynh đồng ý; không thu thập dữ liệu trẻ ngoài phạm vi được phép.`;
  return common;
}

function dataFor(req) {
  if (req.table === 7 || req.table === 5) return "BT-PAIR, BT-HFP-MIC, BT-HFP-SPK, BT-RECONNECT; ma trận Android/iOS và trạng thái HFP/BLE.";
  if (req.table === 8) return "HW-CHARGE, HW-BATTERY, HW-THERMAL, ENV-QUIET, ENV-HOME, ENV-CLASS.";
  if (req.table === 9) return "CMD-LEARN-*, CMD-NEW-*, CMD-TRANS-*, CMD-NAV-*, NEG-NO-SPEECH, NEG-GIBBERISH.";
  if (req.table === 10) return "TR-CORE-*, TR-SLOW-01, NET-WIFI, NET-WEAK, NET-OFFLINE.";
  if (req.table === 11) return "AGE-*, CONTENT-*, SAFE-* và tài khoản phụ huynh/trẻ.";
  if (req.table === 12) return "VOICE-B/N/T, ENV-QUIET, ENV-TV, ENV-CLASS; hồ sơ consent ẩn danh.";
  if (req.table === 13) return "DEV-AND-01/02, DEV-IOS-01; NET-*; INT-CALL/LOCK/BG/AUDIO.";
  if (req.table === 14) return "UAT-CHILD-*, UAT-PARENT-*; kịch bản quan sát có đồng ý.";
  return "Theo tiêu chí nguồn và dữ liệu/bằng chứng được nêu trong sheet Dữ liệu test.";
}

function stepsFor(req) {
  return [
    `1. Ghi mã thiết bị, firmware, build ứng dụng, điện thoại/OS, mạng và thời điểm bắt đầu.`,
    `2. Thiết lập đúng trạng thái để kiểm tra: ${req.title}.`,
    `3. Thực hiện hành vi/kịch bản theo tiêu chí nguồn; dùng đối chứng hoặc biến thể dữ liệu khi tiêu chí yêu cầu.`,
    `4. Lặp trên các nền tảng/môi trường áp dụng và ghi số lần, thời gian, tỷ lệ hoặc quan sát thực tế.`,
    `5. Lưu video/log/ảnh/âm thanh; so sánh với kết quả mong đợi và cập nhật Result, Defect ID, Evidence.`,
  ].join("\n");
}

const requirements = [];
for (const block of source.blocks) {
  if (block.type !== "table" || !tableMeta[block.number] || block.column_count !== 7) continue;
  const meta = tableMeta[block.number];
  const dataRows = block.rows.slice(1);
  dataRows.forEach((row, index) => {
    const sourceCode = String(row[0]).trim();
    const reqId = block.number === 4
      ? `${meta.prefix}-${sourceCode}-${String(index + 1).padStart(2, "0")}`
      : `${meta.prefix}-${sourceCode}`;
    requirements.push({
      reqId,
      sourceCode,
      table: block.number,
      section: meta.section,
      module: meta.module,
      title: String(row[1]).trim(),
      criteria: String(row[2]).trim(),
      priority: String(row[3]).trim(),
      evidenceHint: String(row[5] ?? "").trim(),
      sourceEvidenceCode: String(row[6] ?? "").trim(),
    });
  });
}

const reqById = new Map(requirements.map((r) => [r.reqId, r]));
const testCases = [];
function addCase(req, overrides = {}) {
  const tc = {
    reqId: req.reqId,
    sourceCode: req.sourceCode,
    module: req.module,
    title: overrides.title ?? `Xác minh: ${req.title}`,
    priority: overrides.priority ?? req.priority,
    type: overrides.type ?? classifyType(req),
    level: overrides.level ?? (req.priority === "Tương lai" ? "Review readiness" : "System/UAT"),
    platform: overrides.platform ?? platformFor(req),
    preconditions: overrides.preconditions ?? preconditionsFor(req),
    testData: overrides.testData ?? dataFor(req),
    steps: overrides.steps ?? stepsFor(req),
    expected: overrides.expected ?? req.criteria,
    result: req.priority === "Tương lai" ? "Không áp dụng (Tương lai)" : "Chưa test",
    defectId: "",
    evidence: "",
    actual: "",
    tester: "",
    executionDate: null,
    notes: overrides.notes ?? (req.evidenceHint ? `Gợi ý bằng chứng nguồn: ${req.evidenceHint} | Mã nguồn: ${req.sourceEvidenceCode}` : `Mã bằng chứng nguồn: ${req.sourceEvidenceCode}`),
  };
  testCases.push(tc);
}

for (const req of requirements) addCase(req);

function addVariant(reqId, spec) {
  const req = reqById.get(reqId);
  if (!req) throw new Error(`Unknown requirement: ${reqId}`);
  addCase(req, spec);
}

const commonEvidence = "Ghi video đồng bộ màn hình + thiết bị; lưu log ứng dụng/BLE và timestamp; mỗi lần chạy có mã evidence riêng.";

addVariant("GATE-G01", {
  title: "Đối chứng nguồn micro HFP trên Android",
  platform: "Android + AIV1/H20",
  testData: "BT-HFP-MIC; 3 tư thế: che micro điện thoại, đặt điện thoại xa, đặt thiết bị gần người nói.",
  steps: "1. Ghép HFP+BLE và mở luồng ghi âm.\n2. Che micro điện thoại, đặt điện thoại cách người nói >=3 m.\n3. Nói câu TR-CORE-01 vào micro thiết bị.\n4. Lặp lại khi che micro thiết bị và nói gần điện thoại để đối chứng.\n5. So sánh waveform/ASR, log audio route và video.",
  expected: "Chỉ kịch bản nói gần micro thiết bị cho tín hiệu/ASR đúng; audio route xác nhận HFP input, không dùng micro điện thoại.",
  type: "Integration",
  notes: commonEvidence,
});
addVariant("GATE-G01", {
  title: "Đối chứng nguồn loa HFP trên Android",
  platform: "Android + AIV1/H20",
  testData: "BT-HFP-SPK; câu TTS chuẩn; mức âm lượng thấp/trung bình/cao.",
  steps: "1. Ghép HFP+BLE.\n2. Kích hoạt phát câu tiếng Anh.\n3. Che loa điện thoại và quan sát nguồn phát.\n4. Thay đổi âm lượng theo thiết kế.\n5. Ghi video và audio route log.",
  expected: "Âm thanh chỉ phát từ loa thiết bị; không phát ngoài ý muốn từ điện thoại; điều khiển âm lượng đúng thiết kế.",
  type: "Integration",
  notes: commonEvidence,
});
addVariant("GATE-G01", {
  title: "Đối chứng HFP hai chiều trên iPhone/build iOS",
  platform: "iPhone thật + build iOS + AIV1/H20",
  testData: "BT-HFP-MIC, BT-HFP-SPK; cùng câu và mức âm lượng như Android.",
  steps: "1. Cài build iOS tương ứng và ghép thiết bị.\n2. Thực hiện phép thử che/đặt xa micro điện thoại.\n3. Phát TTS và đối chứng loa điện thoại/loa thiết bị.\n4. Kiểm tra route trước và sau khi app xuống nền.\n5. Lưu video/log.",
  expected: "Input và output đều đi qua HFP của thiết bị trên iPhone; không đổi route im lặng hoặc sai nguồn.",
  type: "Integration/Compatibility",
  notes: "APK không cài được trên iPhone; ca này yêu cầu build iOS tương ứng. " + commonEvidence,
});
addVariant("GATE-G02", {
  title: "HFP ghi âm đồng thời nhận sự kiện MAIN qua BLE",
  testData: "30 lần nhấn ngắn MAIN trong khi ghi âm; pin và APP State đọc trước/sau.",
  steps: "1. Bắt đầu ghi âm qua HFP.\n2. Nhấn ngắn MAIN 30 lần, cách nhau >=2 giây.\n3. Đếm sự kiện tại firmware, BLE log và app.\n4. Đọc pin/APP State.\n5. Kiểm tra audio không gián đoạn ngoài thiết kế.",
  expected: "BLE không rớt; mỗi lần nhấn tạo đúng 1 sự kiện end-to-end; không mất/lặp; audio route ổn định.",
  type: "Integration/Reliability",
});
addVariant("GATE-G02", {
  title: "HFP phát TTS đồng thời duy trì BLE",
  testData: "20 câu TTS liên tiếp; thao tác MAIN và đọc pin xen kẽ.",
  steps: "1. Bắt đầu phát chuỗi 20 câu TTS qua thiết bị.\n2. Xen kẽ đọc pin và APP State.\n3. Nhấn MAIN ở các trạng thái phát/chuyển câu.\n4. Theo dõi BLE disconnect/reconnect và audio underrun.\n5. Lưu log.",
  expected: "BLE duy trì; trạng thái và pin đọc được; sự kiện MAIN chính xác; không mất tiếng/rè/crash.",
  type: "Integration/Reliability",
});
addVariant("GATE-G02", {
  title: "Khôi phục HFP và BLE sau gián đoạn",
  testData: "10 chu kỳ tắt/bật Bluetooth và 5 chu kỳ ra/vào phạm vi.",
  steps: "1. Xác nhận HFP+BLE đang hoạt động.\n2. Tắt Bluetooth 10 giây rồi bật lại; lặp 10 lần.\n3. Thực hiện 5 chu kỳ ra/vào phạm vi.\n4. Sau mỗi lần, ghi riêng thời gian phục hồi HFP/BLE.\n5. Chạy 1 câu ghi âm và 1 câu phát để xác nhận end-to-end.",
  expected: "Hai kênh phục hồi theo thiết kế, không cần xóa dữ liệu/ghép lại ngoài dự kiến; chức năng cốt lõi dùng được sau mỗi chu kỳ.",
  type: "Recovery/Reliability",
});
addVariant("GATE-G03", {
  title: "Biên thời gian nhấn ngắn/nhấn giữ MAIN",
  testData: "Ngưỡng nhấn giữ theo Cấu hình; thử ngưỡng -0,2 s / đúng ngưỡng / +0,2 s, mỗi điểm 10 lần.",
  steps: "1. Điền ngưỡng nhấn giữ đã phê duyệt.\n2. Nhấn tại ba điểm biên, mỗi điểm 10 lần.\n3. Lặp khi chờ, phát TTS, ghi âm và dịch liên tục.\n4. Đếm sự kiện short/long và chuyển trạng thái.\n5. Lưu log timestamp.",
  expected: "Phân loại nhất quán theo đặc tả; một thao tác chỉ sinh một sự kiện; long press dừng an toàn, không nhảy sai màn hình.",
  type: "Boundary/State transition",
});
addVariant("GATE-G04", {
  title: "Cổng câu lệnh có kiểm soát theo ba vùng giọng",
  testData: "CMD-LEARN-*, CMD-NEW-*, CMD-TRANS-*; tối thiểu 1 trẻ thật/vùng Bắc-Trung-Nam có consent.",
  steps: "1. Chạy cùng bộ câu lệnh cho từng vùng giọng.\n2. Mỗi câu lặp 3 lần ở âm lượng bình thường.\n3. Ghi intent nhận được, module mở và fallback.\n4. Với câu không hiểu, xác nhận chỉ hướng dẫn lại.\n5. Tính tỷ lệ đúng theo vùng và theo intent.",
  expected: "Các intent hợp lệ vào đúng module; câu không hiểu không tự nhảy chức năng; kết quả tách riêng theo vùng, không gộp che lỗi.",
  type: "Voice/Localization",
});
addVariant("GATE-G05", {
  title: "Dịch liên tục không nhận nhầm âm thanh môi trường",
  testData: "ENV-TV, ENV-ADULT, ENV-CLASS; 3 khoảng im lặng 10/20/30 giây.",
  steps: "1. Bật dịch liên tục.\n2. Trẻ nói 1 câu hợp lệ rồi im lặng.\n3. Phát từng nguồn ồn trong 10/20/30 giây.\n4. Theo dõi VAD/ASR/API call/TTS.\n5. Dừng chế độ và xác nhận không còn xử lý.",
  expected: "Không biến tiếng môi trường/người khác thành câu của trẻ; không phát TTS sai; dừng được và ngừng gửi dữ liệu.",
  type: "Negative/Voice",
});
addVariant("GATE-G06", {
  title: "Giọng trẻ trong nhiễu và giọng người lớn chen ngang",
  testData: "VOICE-B/N/T; ENV-HOME/TV/CLASS; câu cốt lõi TR-CORE-*.",
  steps: "1. Đặt thiết bị ở vị trí sử dụng thật.\n2. Trẻ nói câu cốt lõi trong từng môi trường.\n3. Cho người lớn nói chen và TV phát lời thoại.\n4. Ghi ASR, bản dịch, độ trễ và nguồn giọng bị nhận.\n5. Phân loại từng lỗi theo taxonomy.",
  expected: "Câu trẻ vẫn sử dụng được ở mức cốt lõi; không thường xuyên mất từ/nhảy module; không nhận giọng người khác; lỗi được phân loại và đưa vào hồi quy.",
  type: "Voice/Robustness",
});
for (const [platform, title] of [["Android thật", "Chuỗi cốt lõi end-to-end trên Android"], ["iPhone thật/build iOS", "Chuỗi cốt lõi end-to-end trên iPhone"]]) {
  addVariant("GATE-G07", {
    title,
    platform: `${platform} + AIV1/H20`,
    testData: "Kết nối -> MAIN -> ghi âm -> dịch -> TTS -> bài học -> mất/kết nối lại.",
    steps: "1. Cài mới ứng dụng và cấp quyền.\n2. Ghép HFP+BLE.\n3. Chạy MAIN, ghi âm, dịch, phát TTS và một bài học.\n4. Gây mất kết nối rồi phục hồi.\n5. Ghi model/OS/build và evidence từng chặng.",
    expected: "Toàn bộ chuỗi chạy được trên thiết bị thật; không có chặng cốt lõi bị bỏ qua; kết nối lại thành công và phiên bản được truy vết.",
    type: "End-to-end/Compatibility",
  });
}
addVariant("GATE-G08", {
  title: "Chu kỳ sạc đầy và kiểm tra an toàn",
  platform: "Thiết bị AIV1/H20",
  testData: "HW-CHARGE; pin thấp -> đầy; dây/củ sạc chuẩn.",
  steps: "1. Ghi % pin, nhiệt độ bề mặt và bộ sạc.\n2. Sạc từ mức pin thấp đến đầy.\n3. Ghi thời gian, % pin và nhiệt định kỳ.\n4. Kiểm tra mùi, phồng, reset, lỏng cổng.\n5. Sau đầy pin chạy chức năng cốt lõi 15 phút.",
  expected: "Sạc hoàn tất bình thường; không nóng/mùi/phồng/reset bất thường; thiết bị dùng được sau khi đầy; dữ liệu sạc đầy đủ.",
  type: "Hardware/Safety",
});
addVariant("GATE-G08", {
  title: "Soak pin theo hỗn hợp sử dụng điển hình",
  platform: "Thiết bị AIV1/H20",
  testData: "Chu kỳ 5 phút chờ + 5 phút phát + 5 phút ghi/dịch; lặp đến ngưỡng kết thúc đã duyệt.",
  steps: "1. Sạc đầy và ghi % pin ban đầu.\n2. Chạy hỗn hợp sử dụng theo chu kỳ.\n3. Ghi % pin, nhiệt, disconnect và reset mỗi 15 phút.\n4. Kết thúc theo tiêu chí Cấu hình.\n5. Tính thời lượng thực tế và lưu log.",
  expected: "Có số liệu runtime thực tế; không tắt nguồn/nóng bất thường/rớt kết nối thường xuyên; so sánh được với ngưỡng đã phê duyệt.",
  type: "Battery/Reliability",
});

for (const [platform, title] of [["Android", "Cài mới sạch và mở lại trên Android"], ["iOS", "Cài mới sạch và mở lại trên iPhone/build iOS"]]) {
  addVariant("SETUP-A02", {
    title,
    platform,
    testData: "Xóa ứng dụng và dữ liệu; cài build đã khóa; mạng tốt và mạng yếu.",
    steps: "1. Gỡ bản cũ/xóa dữ liệu.\n2. Cài build mới và mở lần đầu.\n3. Cấp quyền theo luồng.\n4. Đóng cưỡng bức và mở lại 3 lần.\n5. Ghi thời gian tới màn hình sẵn sàng và mọi lỗi UI.",
    expected: "Không treo, trắng, crash hay tải vô hạn; quyền được giải thích; mở lại ổn định và trạng thái hợp lệ.",
    type: "Install/Compatibility",
  });
}
addVariant("SETUP-A03", {
  title: "Từ chối quyền micro rồi khôi phục",
  testData: "Từ chối một lần; từ chối vĩnh viễn nếu OS hỗ trợ; bật lại trong Settings.",
  steps: "1. Cài mới và từ chối quyền micro.\n2. Mở chức năng cần micro.\n3. Kiểm tra lời giải thích và đường dẫn Settings.\n4. Bật lại quyền.\n5. Quay lại app và chạy ghi âm không cài lại.",
  expected: "App không crash/treo; thông báo dễ hiểu; không báo thành công giả; sau khi bật lại quyền, ghi âm dùng được mà không mất cấu hình.",
  type: "Negative/Permission",
});
addVariant("SETUP-A03", {
  title: "Từ chối Bluetooth/thiết bị lân cận rồi khôi phục",
  testData: "Android/iOS theo cơ chế quyền Bluetooth của OS.",
  steps: "1. Từ chối quyền Bluetooth/nearby.\n2. Thử tìm và kết nối thiết bị.\n3. Kiểm tra thông báo và hướng dẫn.\n4. Bật lại quyền trong Settings.\n5. Kết nối lại không cài mới.",
  expected: "Không hiển thị lỗi kỹ thuật khó hiểu; không báo đã kết nối; có thể khôi phục và ghép thiết bị sau khi cấp quyền.",
  type: "Negative/Permission",
});
addVariant("BT-B01", {
  title: "Hủy ghép và ghép lại khi có hai thiết bị cùng khu vực",
  testData: "2 mẫu thiết bị; tên quảng bá đã cấu hình; Android và iPhone.",
  steps: "1. Bật hai thiết bị cạnh nhau.\n2. Tìm kiếm và xác nhận tên/ID phân biệt.\n3. Ghép mẫu A, hủy ghép, ghép mẫu B.\n4. Ghép lại mẫu A.\n5. Xác nhận không dùng nhầm profile/phiên bản.",
  expected: "Tên/ID đủ phân biệt; ghép-hủy-ghép lại thành công; app không trộn thiết bị hoặc dữ liệu phiên trước.",
  type: "Integration/Negative",
});
addVariant("BT-B06", {
  title: "Độ tin cậy nhấn ngắn MAIN 30 lần",
  testData: "30 lần nhấn ngắn ở trạng thái chờ, phát, bài học và dịch.",
  steps: "1. Mở log firmware/BLE/app.\n2. Ở mỗi trạng thái, nhấn ngắn theo kế hoạch.\n3. Đếm physical action, BLE event và app action.\n4. So sánh timestamp.\n5. Ghi mọi mất/lặp/sai trạng thái.",
  expected: "Mỗi thao tác sinh đúng một sự kiện và một hành động hợp lệ; không mất, lặp hoặc xử lý theo state cũ.",
  type: "Reliability/State transition",
});
addVariant("BT-B07", {
  title: "Độ tin cậy nhấn giữ MAIN 30 lần",
  testData: "30 long press, xen kẽ short press; các trạng thái chờ/phát/ghi/dịch liên tục.",
  steps: "1. Điền ngưỡng long press.\n2. Thực hiện long press và short press xen kẽ.\n3. Theo dõi event và hành động dừng.\n4. Giữ lâu hơn ngưỡng 3 giây để kiểm tra không lặp.\n5. Tổng hợp theo trạng thái.",
  expected: "Long press chỉ kích hoạt một lần; short không bị hiểu nhầm; trạng thái dừng an toàn và không lặp event khi tiếp tục giữ.",
  type: "Reliability/Boundary",
});
for (const spec of [
  ["Tắt/bật Bluetooth", "Tắt Bluetooth 10 giây rồi bật; lặp 10 chu kỳ."],
  ["Ra ngoài/vào lại phạm vi", "Di chuyển tới khi cả HFP/BLE mất rồi quay lại; lặp 5 chu kỳ."],
  ["Đưa app xuống nền rồi trở lại", "Đưa app nền 60 giây, khóa/mở màn hình rồi foreground; lặp 5 chu kỳ."],
]) {
  addVariant("BT-B10", {
    title: `Kết nối lại sau ${spec[0]}`,
    testData: spec[1],
    steps: `1. Xác nhận HFP+BLE và chạy 1 giao dịch chuẩn.\n2. ${spec[1]}\n3. Ghi riêng thời gian phục hồi HFP và BLE.\n4. Chạy MAIN, ghi âm và phát TTS.\n5. Lưu log các lần thất bại.`,
    expected: "Kết nối phục hồi theo thiết kế; UI không báo sai; chức năng cốt lõi hoạt động lại; có số liệu thời gian và tỷ lệ thành công.",
    type: "Recovery/Reliability",
  });
}
addVariant("HW-C03", {
  title: "Sạc với dây đi kèm và dây chuẩn tương thích",
  platform: "Thiết bị AIV1/H20",
  testData: "Dây đi kèm + 2 dây chuẩn; củ sạc theo thông số ODM.",
  steps: "1. Kiểm tra ngoại quan cổng/dây.\n2. Cắm/rút mỗi dây 10 lần.\n3. Sạc 15 phút với từng tổ hợp.\n4. Quan sát lỏng, mất sạc và nhiệt.\n5. Ghi dòng/áp nếu có dụng cụ.",
  expected: "Cắm đúng hướng, không lỏng; sạc ổn định với dây hợp lệ; không nóng bất thường hoặc ngắt chập chờn.",
  type: "Hardware/Safety",
});
addVariant("HW-C07", {
  title: "Soak nhiệt khi sạc, phát và dịch liên tục",
  platform: "Thiết bị AIV1/H20",
  testData: "Ba pha: sạc, phát TTS, dịch liên tục; nhiệt độ môi trường được ghi nhận.",
  steps: "1. Ghi nhiệt độ ban đầu.\n2. Chạy từng pha theo thời lượng đã duyệt.\n3. Đo/quan sát nhiệt định kỳ.\n4. Theo dõi mùi, phồng, reset, mất kết nối.\n5. Dừng ngay nếu có dấu hiệu an toàn.",
  expected: "Không có mùi/phồng/reset/nóng vượt ngưỡng đã phê duyệt; dữ liệu đủ để kết luận P0.",
  type: "Hardware/Safety",
});
addVariant("HW-C08", {
  title: "Chất lượng loa trong ba môi trường",
  platform: "Thiết bị AIV1/H20",
  testData: "ENV-QUIET, ENV-HOME, ENV-CLASS; mức âm lượng thấp/trung bình/cao.",
  steps: "1. Phát cùng bộ câu tiếng Anh ở ba mức âm lượng.\n2. Lặp trong từng môi trường.\n3. Người lớn và trẻ đánh giá nghe rõ/chói/rè/nổ.\n4. Ghi mức âm lượng và khoảng cách.\n5. Lưu mẫu âm thanh.",
  expected: "Đủ nghe trong môi trường mục tiêu nhưng không chói/rè/nổ; kết quả tách riêng theo môi trường và mức âm lượng.",
  type: "Audio/Usability",
});
addVariant("MAIN-D02", {
  title: "Timeout không có tiếng nói và thoát an toàn",
  testData: "NEG-NO-SPEECH; không phát âm trong hai cửa sổ nghe liên tiếp.",
  steps: "1. Ở trạng thái chờ, nhấn MAIN.\n2. Im lặng khoảng 6 giây.\n3. Xác nhận chỉ nhắc lại một lần.\n4. Tiếp tục im lặng.\n5. Xác nhận lời nhắc kết thúc và app thoát trạng thái nghe.",
  expected: "Nhắc lại đúng một lần; sau lần hai thông báo bấm MAIN khi sẵn sàng; không kẹt mic, không quay tải, không tự vào module.",
  type: "Negative/State transition",
});
addVariant("MAIN-D03", {
  title: "Fallback với câu linh tinh/độ tin cậy thấp",
  testData: "NEG-GIBBERISH, NEG-LOW-CONF, tiếng TV nền.",
  steps: "1. Nhấn MAIN và phát từng dữ liệu âm thanh.\n2. Ghi ASR confidence/intent nếu có.\n3. Quan sát module/state sau phản hồi.\n4. Thử lại bằng câu lệnh hợp lệ.\n5. Lặp trên Android/iOS.",
  expected: "Không nhảy sai module; đưa ví dụ câu lệnh có kiểm soát; cho thử lại; câu hợp lệ tiếp theo được xử lý bình thường.",
  type: "Negative/Voice",
});
for (const [reqId, title, data] of [
  ["MAIN-D04", "Ma trận biến thể lệnh vào học theo chủ đề", "Học bài | Học theo chủ đề | Học khóa học | Bắt đầu bài học"],
  ["MAIN-D05", "Ma trận biến thể lệnh vào học từ mới", "Học từ mới | Học từ | Luyện từ"],
  ["MAIN-D06", "Ma trận biến thể lệnh vào dịch", "Dịch tiếng Anh | Con muốn dịch | Dịch một câu | Dịch liên tục"],
]) {
  addVariant(reqId, {
    title,
    testData: data,
    steps: "1. Đưa app về trạng thái chờ trước mỗi lần.\n2. Nhấn MAIN và nói từng biến thể, mỗi câu 3 lần.\n3. Ghi ASR text, intent và module mở.\n4. Lặp với giọng Bắc/Trung/Nam nếu có mẫu.\n5. Tổng hợp nhận đúng/bỏ sót/nhầm module.",
    expected: "Mọi biến thể hợp lệ được quy về đúng intent/module; không coi câu điều khiển là nội dung dịch; lỗi có log và audio truy vết.",
    type: "Voice/Functional",
  });
}
addVariant("MAIN-D10", {
  title: "Long press dừng an toàn ở mọi trạng thái cốt lõi",
  testData: "Trạng thái: phát TTS, ghi luyện nói, chờ lệnh, dịch liên tục, đang chuyển câu.",
  steps: "1. Đưa hệ thống vào từng trạng thái.\n2. Nhấn giữ MAIN theo ngưỡng.\n3. Đo thời gian tới khi dừng và nghe lời xác nhận.\n4. Mở lại bài/luồng.\n5. Xác nhận tiến độ và state không hỏng.",
  expected: "Dừng/tạm dừng ngay theo thiết kế, phát 'Đã dừng', không mất tiến độ, không nhảy màn hình hoặc để mic tiếp tục thu.",
  type: "State transition/Safety",
});
addVariant("TRANS-E02", {
  title: "Bảo toàn xưng hô, chủ ngữ, phủ định và nhu cầu",
  testData: "TR-CORE-01..06, gồm 'Mẹ ơi, con muốn mua cái này', câu phủ định và câu có chủ ngữ.",
  steps: "1. Chạy từng câu ở chế độ dịch từng câu.\n2. Lưu audio gốc và bản chép tay.\n3. Ghi ASR tiếng Việt, câu tiếng Anh và TTS.\n4. Đánh dấu mất xưng hô/chủ ngữ/phủ định/nhu cầu.\n5. Phân loại lỗi trước khi tạo defect.",
  expected: "Các thành phần nghĩa quan trọng không thường xuyên bị mất; mọi sai lệch có đủ audio, transcript, ASR, translation, TTS và timestamp.",
  type: "Functional/Localization",
});
for (const [title, stopAction] of [["Dừng dịch liên tục bằng câu lệnh", "Nói 'Dừng lại'"], ["Dừng dịch liên tục bằng long press MAIN", "Nhấn giữ MAIN"]]) {
  addVariant("TRANS-E04", {
    title,
    testData: `${stopAction}; sau đó phát tiếng TV và lời người lớn trong 30 giây.`,
    steps: `1. Bật dịch liên tục và dịch thành công 2 lượt.\n2. ${stopAction}.\n3. Xác nhận trạng thái đã dừng.\n4. Phát tiếng môi trường 30 giây.\n5. Kiểm tra VAD/ASR/API/log.`,
    expected: "Luồng dừng được; không thu/gửi/xử lý âm thanh môi trường sau dừng; có phản hồi rõ và có thể bắt đầu phiên mới.",
    type: "State transition/Privacy",
  });
}
addVariant("TRANS-E05", {
  title: "VAD với trẻ nói chậm và dừng giữa câu",
  testData: "TR-SLOW-01..03; khoảng dừng 0,5/1/1,5/2 giây giữa cụm từ.",
  steps: "1. Chạy từng câu với bốn mức khoảng dừng.\n2. Lưu audio và timestamp VAD start/end.\n3. Ghi số lần cắt câu hoặc chờ quá lâu.\n4. So sánh ASR với transcript chuẩn.\n5. Ghi ngưỡng hoạt động thực tế.",
  expected: "Không cắt quá sớm khoảng dừng tự nhiên và không chờ quá lâu; có số liệu ngưỡng để PO/QA phê duyệt.",
  type: "Boundary/Performance",
});
addVariant("TRANS-E07", {
  title: "Lỗi mạng/API và thử lại có kiểm soát",
  testData: "NET-WEAK, NET-OFFLINE, giả lập timeout/5xx nếu môi trường cho phép.",
  steps: "1. Bắt đầu dịch rồi gây từng loại lỗi.\n2. Đo thời gian tới phản hồi lỗi.\n3. Xác nhận không báo thành công và không quay vô hạn.\n4. Khôi phục mạng/API và bấm thử lại.\n5. Kiểm tra state và dữ liệu không bị trùng.",
  expected: "Thông báo ngắn, trẻ hiểu được; có thể thử lại; khôi phục thành công; không mất state hoặc tạo bản ghi lịch sử sai/trùng.",
  type: "Negative/Recovery",
});
addVariant("LEARN-F01", {
  title: "Ranh giới nhóm tuổi và nội dung bài học",
  testData: "AGE-LOW/BOUNDARY/HIGH; cùng chủ đề để so sánh độ khó.",
  steps: "1. Tạo hồ sơ ở các tuổi biên.\n2. Mở cùng chủ đề.\n3. Ghi câu, độ dài, từ vựng và hướng dẫn.\n4. Đổi tuổi bằng tài khoản phụ huynh.\n5. Xác nhận nội dung cập nhật đúng và trẻ không cần chọn trên điện thoại.",
  expected: "Chủ đề/câu/độ khó phù hợp nhóm tuổi; chuyển tuổi không giữ nội dung sai; trẻ vào bài từ thiết bị sau thiết lập.",
  type: "Boundary/Content",
});
addVariant("LEARN-F07", {
  title: "Phụ huynh thêm nội dung và trẻ không có quyền quản lý",
  testData: "CONTENT-WORD, CONTENT-PHRASE, CONTENT-SENTENCE; tài khoản phụ huynh và luồng trẻ.",
  steps: "1. Phụ huynh thêm ba loại nội dung.\n2. Xác nhận/duyệt nếu có.\n3. Từ thiết bị trẻ, mở học từ mới.\n4. Thử thao tác thêm/sửa/xóa từ luồng trẻ.\n5. Kiểm tra lịch sử và đồng bộ.",
  expected: "Chỉ phụ huynh quản lý nội dung; trẻ học được nội dung đã duyệt mà không cần cầm điện thoại; không có đường tắt vượt quyền.",
  type: "Authorization/Functional",
});
addVariant("LEARN-F08", {
  title: "Từ đơn không khớp kho câu được duyệt",
  testData: "CONTENT-UNKNOWN-01..03; từ hiếm/đa nghĩa nhưng không chứa nội dung cấm.",
  steps: "1. Phụ huynh thêm từng từ đơn.\n2. Kiểm tra tra cứu kho 5.000 câu.\n3. Với trường hợp không khớp, quan sát phản hồi.\n4. Kiểm tra có tự tạo câu hay không.\n5. Xác nhận chỉ đưa vào học sau phê duyệt.",
  expected: "Ưu tiên câu đã duyệt; nếu không có thì báo chờ xác nhận; không tự tạo nội dung không phù hợp tuổi.",
  type: "Negative/Content",
});
addVariant("LEARN-F10", {
  title: "Bộ dữ liệu nội dung không phù hợp và phản hồi an toàn",
  testData: "SAFE-PROFANITY, SAFE-SEXUAL, SAFE-VIOLENCE, SAFE-INSULT, đầu vào lách ký tự.",
  steps: "1. Nhập từng nhóm dữ liệu qua các điểm cho phép phụ huynh thêm nội dung.\n2. Thử biến thể viết sai/lách ký tự.\n3. Quan sát nội dung lưu, câu sinh và TTS.\n4. Kiểm tra thông báo.\n5. Xác nhận không xuất hiện trong bài/lịch sử trẻ.",
  expected: "Nội dung cấm không được đưa tới trẻ hoặc phát TTS; phản hồi an toàn, phù hợp tuổi; không rò nội dung qua lịch sử/cache.",
  type: "Safety/Content",
});
addVariant("VOICE-G02", {
  title: "So sánh cùng intent theo Bắc/Trung/Nam",
  testData: "Cùng bộ 20 intent cốt lõi, tối thiểu 1 trẻ/vùng có consent; ghi giới tính/tuổi ẩn danh.",
  steps: "1. Thu/chạy cùng bộ intent cho từng vùng.\n2. Lặp mỗi intent 3 lần.\n3. Ghi ASR, intent, module và độ trễ.\n4. Tính kết quả riêng từng vùng.\n5. Lưu audio ẩn danh và defect theo vùng.",
  expected: "Kết quả có thể so sánh theo vùng; lỗi nêu rõ vùng/câu/điều kiện; không gắn nhãn chung chung hoặc che sai lệch vùng.",
  type: "Voice/Localization",
});
addVariant("VOICE-G04", {
  title: "Không nhận giọng TV/người lớn thành lệnh của trẻ",
  testData: "ENV-TV, ENV-ADULT, ENV-CLASS; trẻ im lặng và trẻ nói xen kẽ.",
  steps: "1. Bật trạng thái nghe/dịch liên tục.\n2. Chỉ phát TV/người lớn, trẻ im lặng.\n3. Sau đó cho trẻ nói xen kẽ.\n4. Theo dõi speaker/source, VAD, ASR, intent và API.\n5. Ghi mọi false activation.",
  expected: "Không xử lý tiếng nền/người lớn như lệnh/nội dung của trẻ; khi trẻ nói, câu trẻ vẫn được xử lý đúng.",
  type: "Negative/Voice",
});
addVariant("VOICE-G08", {
  title: "Từ chối/thu hồi consent dữ liệu giọng trẻ",
  testData: "Hồ sơ không consent; hồ sơ đã thu hồi consent; đường dẫn lưu trữ test.",
  steps: "1. Chuẩn bị hai trạng thái consent.\n2. Thử bắt đầu phiên thu/lưu bằng chứng.\n3. Kiểm tra mã hóa ID và quyền truy cập.\n4. Thu hồi consent của một mẫu.\n5. Xác minh dữ liệu được xử lý theo chính sách đã duyệt.",
  expected: "Không thu/dùng dữ liệu ngoài consent; dữ liệu ẩn danh và kiểm soát truy cập; việc thu hồi được ghi nhận và xử lý đúng chính sách.",
  type: "Privacy/Compliance",
});
for (const [title, action] of [
  ["Ứng dụng xuống nền/trở lại", "Đưa app xuống nền 60 giây rồi mở lại"],
  ["Khóa/mở màn hình", "Khóa màn hình 30 giây rồi mở"],
  ["Cuộc gọi đến trong khi ghi/phát", "Nhận một cuộc gọi đến, kết thúc rồi trở lại app"],
]) {
  addVariant("COMP-H03", {
    title,
    testData: `${action}; chạy khi ghi âm, phát TTS và dịch liên tục.`,
    steps: `1. Bắt đầu từng trạng thái cốt lõi.\n2. ${action}.\n3. Quan sát mic, audio route, BLE/HFP và UI state.\n4. Tiếp tục hoặc khởi động lại theo thiết kế.\n5. Lưu log trước/trong/sau gián đoạn.`,
    expected: "Không lỗi im lặng/crash; quyền mic và audio route có hành vi dự đoán được; trạng thái Bluetooth và phục hồi đúng thiết kế.",
    type: "Interruption/Compatibility",
  });
}
for (const [title, profile] of [["Mạng yếu", "NET-WEAK"], ["Mất mạng", "NET-OFFLINE"], ["Khôi phục mạng giữa giao dịch", "NET-RECOVERY"]]) {
  addVariant("COMP-H06", {
    title,
    testData: `${profile}; chạy trang chủ, ASR/dịch và TTS.`,
    steps: "1. Bắt đầu từ mạng tốt và xác nhận baseline.\n2. Áp dụng profile mạng.\n3. Chạy trang chủ, ghi/dịch và phát.\n4. Khôi phục mạng nếu áp dụng.\n5. Ghi thông báo, retry, state và thời gian.",
    expected: "Không báo thành công giả hoặc quay vô hạn; thông báo rõ; khi mạng trở lại tiếp tục dùng được, không mất hoặc nhân đôi trạng thái.",
    type: "Network/Recovery",
  });
}
addVariant("COMP-H08", {
  title: "Soak 2 giờ học/dịch xen kẽ",
  testData: "2 giờ hoặc ngưỡng dài hơn được phê duyệt; chu kỳ học 10 phút + dịch 10 phút + chờ 5 phút.",
  steps: "1. Ghi pin/nhiệt/memory baseline.\n2. Chạy chu kỳ xen kẽ trong 2 giờ.\n3. Mỗi 15 phút ghi crash, ANR, memory, pin, nhiệt, BLE/HFP.\n4. Thực hiện reconnect giữa bài.\n5. Xuất log cuối phiên.",
  expected: "Không crash/ANR/giật rõ/nóng hoặc hao pin bất thường; không rò memory tăng liên tục; mọi bất thường có log.",
  type: "Reliability/Soak",
});
addVariant("COMP-H09", {
  title: "Nâng cấp ứng dụng giữ dữ liệu và liên kết thiết bị",
  testData: "Build N-1 -> N; có lịch sử dịch, tiến độ bài và thiết bị đã ghép.",
  steps: "1. Trên build N-1 tạo dữ liệu và kết nối.\n2. Nâng cấp tại chỗ lên build N.\n3. Mở app, kiểm tra migration.\n4. Chạy lại học/dịch/kết nối.\n5. Thử build không tương thích trong môi trường an toàn nếu có.",
  expected: "Không mất lịch sử/tiến độ/kết nối mà không báo; migration không crash; phiên bản không tương thích có cảnh báo an toàn.",
  type: "Upgrade/Compatibility",
});
addVariant("UX-I01", {
  title: "Trẻ hoàn thành luồng cơ bản không cầm điện thoại",
  testData: "UAT-CHILD-01; nhiệm vụ bắt đầu-nghe-nói-dừng-tiếp tục; người lớn không hướng dẫn trừ an toàn.",
  steps: "1. Phụ huynh hoàn tất thiết lập rồi đặt điện thoại ngoài tầm trẻ.\n2. Giao nhiệm vụ bằng câu trung tính.\n3. Quan sát trẻ bắt đầu, nghe, nói, dừng và tiếp tục.\n4. Ghi số lần cần trợ giúp/bấm nhầm/hụt hẫng.\n5. Phỏng vấn ngắn sau phiên.",
  expected: "Trẻ hoàn thành luồng cơ bản bằng thiết bị; không cần tổ hợp nút phức tạp; mọi điểm cần người lớn trợ giúp được ghi rõ.",
  type: "Usability/UAT",
});
addVariant("UX-I04", {
  title: "Khôi phục sau không hiểu, lỗi mạng và bấm nhầm MAIN",
  testData: "Ba tình huống lỗi; quan sát trẻ thật có consent hoặc phiên mô phỏng trước UAT.",
  steps: "1. Gây từng tình huống trong bài.\n2. Không can thiệp trong khoảng quan sát an toàn.\n3. Ghi lời nhắc, màn hình/state và hành vi trẻ.\n4. Xác nhận có đường thử lại/quay lại.\n5. Ghi trẻ có tiếp tục hay bỏ cuộc.",
  expected: "Không mắc kẹt im lặng hoặc chuyển sai trang; lời nhắc giúp trẻ phục hồi; trạng thái bài không hỏng; quan sát được lưu có consent.",
  type: "Usability/Recovery",
});
addVariant("UX-I07", {
  title: "Độ thoải mái khi đeo/cầm trong phiên sử dụng",
  platform: "Thiết bị AIV1/H20 + UAT trẻ có giám sát",
  testData: "Đi bộ, ngồi học, chạy nhẹ; thời lượng theo phê duyệt an toàn.",
  steps: "1. Kiểm tra ngoại quan và nhiệt trước khi đeo.\n2. Trẻ dùng ở ba hoạt động.\n3. Quan sát trượt/rơi/cọ xát/bấm nhầm/nhiệt/âm lượng.\n4. Hỏi phản hồi ngắn.\n5. Dừng ngay nếu khó chịu hoặc có dấu hiệu an toàn.",
  expected: "Trẻ chấp nhận đeo/cầm; không từ chối do trọng lượng, kẹp, nóng, âm lượng hoặc ngoại hình; sự cố được ghi và xử lý an toàn.",
  type: "Usability/Safety",
});
addVariant("CLOSE-K01", {
  title: "Quyết định NO-GO khi còn P0 Chưa test/Không đạt/Đạt có điều kiện",
  platform: "Workbook/Quy trình nghiệm thu",
  testData: "Mỗi lần đặt một test case P0 ở trạng thái Chưa test, Không đạt, Đạt có điều kiện hoặc N/A.",
  steps: "1. Tạo bản sao kiểm tra nội bộ.\n2. Đặt từng trạng thái chặn cho một P0.\n3. Kiểm tra số đếm Tổng quan.\n4. Kiểm tra quyết định khi chưa có phê duyệt rủi ro.\n5. Khôi phục dữ liệu ban đầu.",
  expected: "Bộ đếm P0 đúng và quyết định là NO-GO khi còn trạng thái chặn, trừ khi có quy trình phê duyệt rủi ro bằng văn bản hợp lệ.",
  type: "Process/Control",
});
addVariant("CLOSE-K01", {
  title: "Quyết định GO khi toàn bộ P0 Đạt",
  platform: "Workbook/Quy trình nghiệm thu",
  testData: "Tất cả test case P0 = Đạt; P1 có thể còn kế hoạch; Future = N/A.",
  steps: "1. Tạo bản sao kiểm tra nội bộ.\n2. Đặt toàn bộ P0 = Đạt.\n3. Giữ P1/Future theo trạng thái hợp lệ.\n4. Kiểm tra số đếm và quyết định.\n5. Khôi phục dữ liệu ban đầu.",
  expected: "P0 blocker = 0 và quyết định hỗ trợ là GO; P1 vẫn phải có owner/ngày khắc phục nếu chưa đóng; Future không chặn V1.",
  type: "Process/Control",
});
addVariant("CLOSE-K03", {
  title: "GO có điều kiện chỉ khi có phê duyệt rủi ro bằng văn bản",
  platform: "Workbook/Quy trình nghiệm thu",
  testData: "Có P0 chưa Đạt; trường phê duyệt rủi ro Có/Không; evidence ID trống/có giá trị.",
  steps: "1. Giữ ít nhất một P0 ở trạng thái chặn.\n2. Đặt Phê duyệt rủi ro = Không và kiểm tra NO-GO.\n3. Đặt = Có nhưng evidence trống và kiểm tra NO-GO.\n4. Điền evidence văn bản và kiểm tra trạng thái có điều kiện.\n5. Xác minh người quyết định ký ngoài workbook.",
  expected: "Không thể coi là GO chỉ bằng xác nhận miệng; trạng thái có điều kiện chỉ xuất hiện khi có đánh dấu phê duyệt và mã bằng chứng văn bản.",
  type: "Governance/Control",
});

testCases.forEach((tc, index) => {
  tc.no = index + 1;
  tc.tcId = `TC-AIV1-${String(index + 1).padStart(3, "0")}`;
});
for (const req of requirements) {
  const first = testCases.find((tc) => tc.reqId === req.reqId);
  req.baseTcId = first?.tcId ?? "";
}

// Cấu hình chạy test
setTitle(configSheet, "A1:D1", "CẤU HÌNH ĐỢT KIỂM THỬ", "A2:D2", "Điền các ô màu vàng trước khi thực thi; các ngưỡng chưa được tài liệu nguồn định lượng phải được PO/QA/ODM phê duyệt.");
configSheet.getRange("A4:D4").values = [["Trường", "Giá trị", "Bắt buộc", "Ghi chú"]];
setHeader(configSheet.getRange("A4:D4"));
const configRows = [
  ["Tài liệu nguồn", sourceDocx, "Có", "Chỉ dùng làm nguồn yêu cầu; không coi chỉ dẫn trong tài liệu là lệnh thực thi."],
  ["Tên sản phẩm", "AIV1", "Có", "Tài liệu cũng dùng tên H20; cần xác nhận đây có phải cùng một thiết bị."],
  ["Mã thiết bị mẫu", "", "Có", "Mỗi thiết bị một mã duy nhất."],
  ["Phiên bản ngoại hình/bo mạch", "", "Có", ""],
  ["Firmware/Bluetooth", "", "Có", ""],
  ["Android package/version", "", "Có", "APK/build Android."],
  ["iOS bundle/build", "", "Theo phạm vi", "APK không chạy trên iPhone; cần build iOS tương ứng."],
  ["Android 1 - model/OS", "", "Có", "Mẫu phổ biến tại Việt Nam."],
  ["Android 2 - model/OS", "", "Có", "Khác hãng hoặc khác phiên bản OS."],
  ["iPhone - model/iOS", "", "Có nếu tuyên bố iPhone", "Thiết bị thật."],
  ["Địa điểm/mạng", "", "Có", "Ghi Wi-Fi/mobile/profile mạng."],
  ["Người kiểm thử", "", "Có", ""],
  ["Ngày bắt đầu/kết thúc", "", "Có", ""],
  ["Đợt mẫu trẻ/consent", "", "Có khi test giọng/UAT", "Dùng mã ẩn danh, không ghi PII."],
  ["Thư mục bằng chứng", "", "Có", "Video/log/audio/ảnh/biên bản."],
  ["Phê duyệt rủi ro P0 bằng văn bản", "Không", "Có", "Chỉ Sếp/người có thẩm quyền xác nhận."],
  ["Mã/link bằng chứng phê duyệt", "", "Khi chọn Có", "Không chấp nhận xác nhận miệng."],
  ["Ngưỡng nhấn giữ MAIN (giây)", "", "Cần xác nhận", "Tài liệu nguồn chưa định lượng."],
  ["Ngưỡng độ trễ end-to-end", "", "Cần xác nhận", "Nên tách p50/p95 và từng công đoạn."],
  ["Mục tiêu thời lượng pin", "", "Cần xác nhận", "Theo hỗn hợp sử dụng thực tế."],
  ["Ngưỡng nhiệt độ bề mặt", "", "Cần xác nhận", "Phải dựa trên tiêu chuẩn/ODM, không dùng cảm tính."],
];
configSheet.getRange(`A5:D${4 + configRows.length}`).values = configRows;
setBody(configSheet.getRange(`A5:D${4 + configRows.length}`), 34);
configSheet.getRange(`B5:B${4 + configRows.length}`).format.fill = colors.yellow;
configSheet.getRange("B20").dataValidation = { rule: { type: "list", values: ["Không", "Có"] } };
setColumnWidth(configSheet, "A", 30, 25);
setColumnWidth(configSheet, "B", 42, 25);
setColumnWidth(configSheet, "C", 18, 25);
setColumnWidth(configSheet, "D", 55, 25);
configSheet.freezePanes.freezeRows(4);

// Test cases
setTitle(casesSheet, "A1:U1", "BỘ TEST CASE NGHIỆM THU AIV1 + ỨNG DỤNG", "A2:U2", `Tổng ${testCases.length} test case; truy vết về 110 tiêu chí nguồn. Result dùng đúng 5 trạng thái của tài liệu nguồn.`);
casesSheet.getRange("A4:U4").merge();
casesSheet.getRange("A4:U4").values = [["Quy tắc: P0 chưa Đạt là điều kiện chặn, trừ khi có phê duyệt rủi ro bằng văn bản. Mọi Không đạt phải có Defect ID và Evidence."]];
casesSheet.getRange("A4:U4").format = { fill: colors.yellow, font: { bold: true, color: colors.redText }, wrapText: true, verticalAlignment: "center" };
casesSheet.getRange("A4:U4").format.rowHeight = 28;
const tcHeaders = ["STT", "Test Case ID", "Requirement ID", "Mã nguồn", "Module", "Tiêu đề", "Mức", "Loại test", "Cấp test", "Nền tảng", "Tiền điều kiện", "Dữ liệu test", "Các bước thực hiện", "Kết quả mong đợi", "Result", "Defect ID", "Evidence ID/Link", "Kết quả thực tế", "Tester", "Ngày chạy", "Ghi chú"];
casesSheet.getRange("A6:U6").values = [tcHeaders];
setHeader(casesSheet.getRange("A6:U6"));
const tcRows = testCases.map((tc) => [
  tc.no, tc.tcId, tc.reqId, tc.sourceCode, tc.module, tc.title, tc.priority, tc.type, tc.level, tc.platform,
  tc.preconditions, tc.testData, tc.steps, tc.expected, tc.result, tc.defectId, tc.evidence, tc.actual, tc.tester, tc.executionDate, tc.notes,
]);
const tcLastRow = 6 + tcRows.length;
casesSheet.getRange(`A7:U${tcLastRow}`).values = tcRows;
setBody(casesSheet.getRange(`A7:U${tcLastRow}`), 72);
casesSheet.getRange(`A7:D${tcLastRow}`).format.verticalAlignment = "center";
casesSheet.getRange(`A7:A${tcLastRow}`).format.horizontalAlignment = "center";
casesSheet.getRange(`B7:D${tcLastRow}`).format.horizontalAlignment = "center";
casesSheet.getRange(`G7:J${tcLastRow}`).format.horizontalAlignment = "center";
casesSheet.getRange(`O7:Q${tcLastRow}`).format.fill = colors.yellow;
casesSheet.getRange(`R7:U${tcLastRow}`).format.fill = "#FFFDF2";
casesSheet.getRange(`O7:O${tcLastRow}`).dataValidation = { rule: { type: "list", values: resultOptions } };
casesSheet.getRange(`G7:G${tcLastRow}`).dataValidation = { rule: { type: "list", values: ["P0", "P1", "Tương lai"] } };
casesSheet.getRange(`T7:T${tcLastRow}`).format.numberFormat = "yyyy-mm-dd";
const resultRange = casesSheet.getRange(`O7:O${tcLastRow}`);
resultRange.conditionalFormats.addCustom('=$O7="Đạt"', { fill: colors.green, font: { color: colors.greenText, bold: true } });
resultRange.conditionalFormats.addCustom('=$O7="Đạt có điều kiện"', { fill: colors.yellow, font: { color: "#7F6000", bold: true } });
resultRange.conditionalFormats.addCustom('=$O7="Không đạt"', { fill: colors.red, font: { color: colors.redText, bold: true } });
resultRange.conditionalFormats.addCustom('=$O7="Chưa test"', { fill: colors.gray, font: { color: colors.darkGray } });
resultRange.conditionalFormats.addCustom('=$O7="Không áp dụng (Tương lai)"', { fill: colors.orange, font: { color: "#9C5700" } });
const priorityRange = casesSheet.getRange(`G7:G${tcLastRow}`);
priorityRange.conditionalFormats.addCustom('=$G7="P0"', { fill: colors.red, font: { color: colors.redText, bold: true } });
priorityRange.conditionalFormats.addCustom('=$G7="P1"', { fill: colors.cyan, font: { color: colors.blue, bold: true } });
priorityRange.conditionalFormats.addCustom('=$G7="Tương lai"', { fill: colors.orange, font: { color: "#9C5700", bold: true } });
const tcTable = casesSheet.tables.add(`A6:U${tcLastRow}`, true, "AIV1TestCases");
tcTable.style = "TableStyleMedium2";
tcTable.showFilterButton = true;
tcTable.showBandedRows = true;
const tcWidths = { A: 6, B: 16, C: 18, D: 10, E: 22, F: 38, G: 10, H: 22, I: 16, J: 24, K: 48, L: 42, M: 70, N: 66, O: 24, P: 16, Q: 28, R: 50, S: 16, T: 13, U: 46 };
for (const [col, width] of Object.entries(tcWidths)) setColumnWidth(casesSheet, col, width, tcLastRow);
casesSheet.freezePanes.freezeRows(6);
casesSheet.freezePanes.freezeColumns(5);

// Tổng quan và quyết định
setTitle(summarySheet, "A1:G1", "TỔNG QUAN NGHIỆM THU AIV1", "A2:G2", "Bảng điều khiển tự động dựa trên Result trong sheet Test Cases. Đây là công cụ hỗ trợ; quyết định cuối cần biên bản và chữ ký có thẩm quyền.");
summarySheet.getRange("A4:G4").merge();
summarySheet.getRange("A4:G4").values = [["Tình trạng thực thi theo mức độ"]];
summarySheet.getRange("A4:G4").format = { fill: colors.teal, font: { bold: true, color: colors.white, size: 12 }, verticalAlignment: "center" };
summarySheet.getRange("A5:G5").values = [["Mức", "Tổng", "Chưa test", "Đạt", "Đạt có điều kiện", "Không đạt", "Không áp dụng"]];
setHeader(summarySheet.getRange("A5:G5"));
summarySheet.getRange("A6:A8").values = [["P0"], ["P1"], ["Tương lai"]];
for (let row = 6; row <= 8; row++) {
  summarySheet.getRange(`B${row}`).formulas = [[`=COUNTIF('Test Cases'!$G$7:$G$${tcLastRow},$A${row})`]];
  summarySheet.getRange(`C${row}`).formulas = [[`=COUNTIFS('Test Cases'!$G$7:$G$${tcLastRow},$A${row},'Test Cases'!$O$7:$O$${tcLastRow},C$5)`]];
  summarySheet.getRange(`D${row}`).formulas = [[`=COUNTIFS('Test Cases'!$G$7:$G$${tcLastRow},$A${row},'Test Cases'!$O$7:$O$${tcLastRow},D$5)`]];
  summarySheet.getRange(`E${row}`).formulas = [[`=COUNTIFS('Test Cases'!$G$7:$G$${tcLastRow},$A${row},'Test Cases'!$O$7:$O$${tcLastRow},E$5)`]];
  summarySheet.getRange(`F${row}`).formulas = [[`=COUNTIFS('Test Cases'!$G$7:$G$${tcLastRow},$A${row},'Test Cases'!$O$7:$O$${tcLastRow},F$5)`]];
  summarySheet.getRange(`G${row}`).formulas = [[`=COUNTIFS('Test Cases'!$G$7:$G$${tcLastRow},$A${row},'Test Cases'!$O$7:$O$${tcLastRow},"Không áp dụng (Tương lai)")`]];
}
setBody(summarySheet.getRange("A6:G8"), 26);
summarySheet.getRange("A6:G6").format.fill = "#FDE9E7";
summarySheet.getRange("A7:G7").format.fill = colors.paleBlue;
summarySheet.getRange("A8:G8").format.fill = colors.orange;
summarySheet.getRange("A10:B10").values = [["Chỉ số kiểm soát", "Giá trị"]];
setHeader(summarySheet.getRange("A10:B10"));
summarySheet.getRange("A11:A15").values = [["P0 blockers"], ["Tỷ lệ đã thực thi P0"], ["Phê duyệt rủi ro P0"], ["Evidence phê duyệt"], ["Khuyến nghị tự động"]];
summarySheet.getRange("B11").formulas = [["=C6+E6+F6+G6"]];
summarySheet.getRange("B12").formulas = [["=IF(B6=0,0,(B6-C6-G6)/B6)"]];
summarySheet.getRange("B13").formulas = [["='Cau hinh'!$B$20"]];
summarySheet.getRange("B14").formulas = [["='Cau hinh'!$B$21"]];
summarySheet.getRange("B15").formulas = [["=IF(B11=0,\"GO - Tất cả P0 đã Đạt\",IF(AND(B13=\"Có\",B14<>\"\"),\"GO CÓ ĐIỀU KIỆN - Kiểm tra văn bản phê duyệt\",\"NO-GO - Còn P0 chưa đóng\"))"]];
setBody(summarySheet.getRange("A11:B15"), 30);
summarySheet.getRange("B12").format.numberFormat = "0%";
summarySheet.getRange("A15:B15").format = { fill: colors.yellow, font: { bold: true, color: colors.redText, size: 11 }, wrapText: true, borders: { preset: "outside", style: "medium", color: colors.redText }, verticalAlignment: "center" };
summarySheet.getRange("A17:G17").merge();
summarySheet.getRange("A17:G17").values = [["Điều kiện thoát: P0 phải Đạt hoặc có phê duyệt rủi ro bằng văn bản; P1 chưa đóng phải có owner/ngày hoàn thành/test lại; Future không chặn V1 và không được quảng bá là đã có."]];
summarySheet.getRange("A17:G17").format = { fill: colors.paleBlue, font: { bold: true, color: colors.blue }, wrapText: true, verticalAlignment: "center" };
summarySheet.getRange("A17:G17").format.rowHeight = 42;
for (const [col, width] of Object.entries({ A: 28, B: 22, C: 18, D: 14, E: 22, F: 16, G: 20 })) setColumnWidth(summarySheet, col, width, 17);

// Phân tích nguồn và gaps
setTitle(analysisSheet, "A1:F1", "PHÂN TÍCH TÀI LIỆU NGUỒN & CHIẾN LƯỢC TEST", "A2:F2", "Phân tích của tester; các ngưỡng đề xuất phải được xác nhận trước khi dùng làm tiêu chí pass/fail.");
analysisSheet.getRange("A4:B4").values = [["Tóm tắt", "Kết quả"]];
setHeader(analysisSheet.getRange("A4:B4"));
const counts = requirements.reduce((acc, r) => ((acc[r.priority] = (acc[r.priority] || 0) + 1), acc), {});
const summaryRows = [
  ["Mục tiêu tài liệu", "Nghiệm thu phối hợp thiết bị mẫu + ứng dụng tại Việt Nam trước quyết định làm khuôn/đặt lô đầu."],
  ["Sản phẩm cốt lõi", "Trẻ nói tiếng Việt -> hệ thống tạo câu tiếng Anh ngắn, có kiểm soát, phù hợp tuổi -> phát giọng -> trẻ bắt chước."],
  ["Ngoài phạm vi V1", "Không phải chatbot tự do; không phải máy dịch vạn năng; OTA và Việt-Trung/Nhật/Hàn chỉ là readiness tương lai."],
  ["Số tiêu chí nguồn", `${requirements.length} (${counts.P0 || 0} P0, ${counts.P1 || 0} P1, ${counts["Tương lai"] || 0} Future).`],
  ["Bộ test case", `${testCases.length} ca, gồm baseline truy vết 1:1 và ca mở rộng rủi ro cao/negative/recovery/soak/UAT.`],
  ["Quy tắc quyết định", "P0 chưa đóng chặn làm khuôn/đặt hàng, trừ phê duyệt rủi ro bằng văn bản. P1 cần kế hoạch. Future không chặn V1."],
];
analysisSheet.getRange(`A5:B${4 + summaryRows.length}`).values = summaryRows;
setBody(analysisSheet.getRange(`A5:B${4 + summaryRows.length}`), 42);

const riskStart = 12;
analysisSheet.getRange(`A${riskStart}:F${riskStart}`).values = [["ID", "Phát hiện/GAP", "Tác động", "Mức", "Khuyến nghị", "Trạng thái quyết định"]];
setHeader(analysisSheet.getRange(`A${riskStart}:F${riskStart}`));
const gaps = [
  ["GAP-01", "Tài liệu dùng lẫn AIV1 và H20.", "Có thể test/đặt hàng nhầm phiên bản phần cứng.", "P0", "Xác nhận tên thương mại, mã ODM và mapping bo mạch trước test.", "Chưa xác nhận"],
  ["GAP-02", "Mã E01 lặp 5 lần; G01-G08 lặp ở hai phần.", "Không truy vết duy nhất giữa lỗi, evidence và quyết định.", "P0", "Dùng Requirement ID chuẩn hóa trong workbook, giữ mã nguồn riêng.", "Đã xử lý trong file"],
  ["GAP-03", "APK không thể cài trên iPhone nhưng tài liệu yêu cầu test iPhone.", "Không thể chứng minh tương thích iPhone nếu không có build iOS.", "P0", "Xác nhận có ứng dụng iOS/bundle build tương ứng; nếu không, ghi Chưa test và không tuyên bố hỗ trợ iPhone.", "Chưa xác nhận"],
  ["GAP-04", "Không có danh sách OS/API level và model mục tiêu.", "Bao phủ tương thích không đủ, dễ bỏ lỗi theo hãng/OS.", "P0", "Chốt ma trận tối thiểu 2 Android khác hãng/OS + 1 iPhone thật, sau đó mở rộng theo thị phần.", "Chưa xác nhận"],
  ["GAP-05", "Không có ngưỡng pass/fail cho độ trễ end-to-end và từng công đoạn.", "Không thể kết luận P0 E06/H05 một cách nhất quán.", "P0", "PO/QA duyệt p50/p95/hard timeout theo Wi-Fi/mobile/weak network.", "Chưa xác nhận"],
  ["GAP-06", "Không định lượng độ chính xác intent/ASR theo vùng, tuổi và môi trường.", "Kết luận 'sử dụng được' mang tính cảm tính.", "P0", "Chốt số mẫu, số câu, success rate tối thiểu và zero-tolerance cho wrong-module critical.", "Chưa xác nhận"],
  ["GAP-07", "Chưa có ngưỡng long press, VAD silence, reconnect timeout.", "Test boundary/state không có oracle rõ.", "P0", "ODM + APK thống nhất thông số, ghi vào sheet Cấu hình trước chạy.", "Chưa xác nhận"],
  ["GAP-08", "Không có mục tiêu thời lượng pin, thời gian sạc và giới hạn nhiệt.", "Rủi ro an toàn và khiếu nại hậu mãi.", "P0", "Dựa trên cell/bộ sạc/tiêu chuẩn ODM để chốt ngưỡng; dùng dụng cụ đo phù hợp.", "Chưa xác nhận"],
  ["GAP-09", "Profile mạng yếu/timeout/API lỗi chưa được định nghĩa.", "Kết quả khó tái lập và so sánh Android/iOS.", "P1", "Định nghĩa latency/bandwidth/loss/offline và phương pháp giả lập.", "Chưa xác nhận"],
  ["GAP-10", "Quy mô mẫu trẻ/consent/retention chưa cụ thể.", "Rủi ro sai lệch thống kê và quyền riêng tư trẻ em.", "P0", "Duyệt protocol nghiên cứu, consent, mã hóa ẩn danh, retention và access control trước thu âm.", "Chưa xác nhận"],
  ["GAP-11", "Định nghĩa kho 5.000 câu, versioning và tỷ lệ match chưa rõ.", "Không thể hồi quy nội dung/cache và tính chi phí.", "P1", "Khóa version dataset, expected mapping, cache source và metric.", "Chưa xác nhận"],
  ["GAP-12", "Contract BLE/GATT, firmware protocol và state machine chưa đính kèm.", "Nguy cơ test theo giả định bo mạch cũ.", "P0", "ODM cung cấp GATT dump, version field, button timing và state transition table.", "Chưa xác nhận"],
];
analysisSheet.getRange(`A${riskStart + 1}:F${riskStart + gaps.length}`).values = gaps;
setBody(analysisSheet.getRange(`A${riskStart + 1}:F${riskStart + gaps.length}`), 58);
analysisSheet.getRange(`D${riskStart + 1}:D${riskStart + gaps.length}`).conditionalFormats.addCustom(`=$D${riskStart + 1}="P0"`, { fill: colors.red, font: { color: colors.redText, bold: true } });

const strategyStart = riskStart + gaps.length + 2;
analysisSheet.getRange(`A${strategyStart}:F${strategyStart}`).merge();
analysisSheet.getRange(`A${strategyStart}:F${strategyStart}`).values = [["Chiến lược thực thi đề xuất"]];
analysisSheet.getRange(`A${strategyStart}:F${strategyStart}`).format = { fill: colors.teal, font: { bold: true, color: colors.white, size: 12 }, verticalAlignment: "center" };
const strategyRows = [
  ["Pha 1", "Smoke + khóa phiên bản", "Cấu hình, clean install, quyền, pairing, GATT, HFP route, MAIN cơ bản.", "P0", "Fail bất kỳ P0 cốt lõi -> dừng mở rộng và debug."],
  ["Pha 2", "Tích hợp cốt lõi", "HFP+BLE đồng thời, voice command, dịch từng câu/liên tục, học, reconnect.", "P0", "Evidence end-to-end trên Android + iOS build thật."],
  ["Pha 3", "Giọng/nội dung/an toàn", "Bắc-Trung-Nam, noise, VAD, translation fidelity, content safety, privacy.", "P0/P1", "Consent và taxonomy lỗi bắt buộc."],
  ["Pha 4", "Non-functional", "Battery/charge/thermal/audio/range, weak network, interruptions, soak, upgrade.", "P0/P1", "So sánh với ngưỡng đã duyệt."],
  ["Pha 5", "UAT trẻ/phụ huynh", "Trẻ tự dùng, vai trò phụ huynh, lời nhắc, hụt hẫng, đeo/cầm.", "P0/P1", "Có giám sát và consent; dừng khi có rủi ro."],
  ["Pha 6", "Closure", "Retest, regression cố định, tổng hợp P0/P1, evidence, chữ ký ODM/APK/Sếp.", "Governance", "Chỉ kết luận theo quy tắc GO/NO-GO nguồn."],
];
analysisSheet.getRange(`A${strategyStart + 1}:E${strategyStart + strategyRows.length}`).values = strategyRows;
setBody(analysisSheet.getRange(`A${strategyStart + 1}:E${strategyStart + strategyRows.length}`), 44);
for (const [col, width] of Object.entries({ A: 16, B: 35, C: 62, D: 15, E: 62, F: 24 })) setColumnWidth(analysisSheet, col, width, strategyStart + strategyRows.length);
analysisSheet.freezePanes.freezeRows(4);

// Traceability
setTitle(traceSheet, "A1:J1", "MA TRẬN TRUY VẾT YÊU CẦU - TEST CASE", "A2:J2", "Requirement ID đã được chuẩn hóa để loại bỏ mã trùng, trong khi Mã nguồn vẫn giữ nguyên để đối chiếu tài liệu Word.");
const traceHeaders = ["Requirement ID", "Mã nguồn", "Phần", "Yêu cầu", "Tiêu chí đạt nguồn", "Mức", "Base TC", "Số TC liên kết", "Đã Đạt", "Trạng thái bao phủ"];
traceSheet.getRange("A5:J5").values = [traceHeaders];
setHeader(traceSheet.getRange("A5:J5"));
const traceRows = requirements.map((req, index) => {
  const row = index + 6;
  return [
    req.reqId, req.sourceCode, req.section, req.title, req.criteria, req.priority, req.baseTcId,
    null, null, null,
  ];
});
const traceLastRow = 5 + traceRows.length;
traceSheet.getRange(`A6:J${traceLastRow}`).values = traceRows;
for (let row = 6; row <= traceLastRow; row++) {
  traceSheet.getRange(`H${row}`).formulas = [[`=COUNTIF('Test Cases'!$C$7:$C$${tcLastRow},A${row})`]];
  traceSheet.getRange(`I${row}`).formulas = [[`=COUNTIFS('Test Cases'!$C$7:$C$${tcLastRow},A${row},'Test Cases'!$O$7:$O$${tcLastRow},"Đạt")`]];
  traceSheet.getRange(`J${row}`).formulas = [[`=IF(H${row}=0,"Thiếu test case",IF(I${row}=H${row},"Đã Đạt toàn bộ","Chưa đóng"))`]];
}
setBody(traceSheet.getRange(`A6:J${traceLastRow}`), 58);
traceSheet.getRange(`F6:F${traceLastRow}`).conditionalFormats.addCustom('=$F6="P0"', { fill: colors.red, font: { color: colors.redText, bold: true } });
traceSheet.getRange(`J6:J${traceLastRow}`).conditionalFormats.addCustom('=$J6="Đã Đạt toàn bộ"', { fill: colors.green, font: { color: colors.greenText, bold: true } });
traceSheet.getRange(`J6:J${traceLastRow}`).conditionalFormats.addCustom('=$J6="Chưa đóng"', { fill: colors.yellow, font: { color: "#7F6000" } });
const traceTable = traceSheet.tables.add(`A5:J${traceLastRow}`, true, "AIV1Traceability");
traceTable.style = "TableStyleMedium2";
for (const [col, width] of Object.entries({ A: 18, B: 10, C: 34, D: 40, E: 72, F: 10, G: 16, H: 15, I: 12, J: 18 })) setColumnWidth(traceSheet, col, width, traceLastRow);
traceSheet.freezePanes.freezeRows(5);
traceSheet.freezePanes.freezeColumns(3);

// Dữ liệu test
setTitle(dataSheet, "A1:G1", "DỮ LIỆU & PROFILE KIỂM THỬ", "A2:G2", "Bộ dữ liệu khởi tạo; cần bổ sung giá trị thật, consent và expected mapping đã được phê duyệt trước khi chạy.");
const dataHeaders = ["Nhóm", "Data ID", "Đầu vào/Profile", "Thiết lập", "Kết quả/Oracle", "Áp dụng cho", "Ghi chú"];
dataSheet.getRange("A5:G5").values = [dataHeaders];
setHeader(dataSheet.getRange("A5:G5"));
const testDataRows = [
  ["Thiết bị", "DEV-AND-01", "Android phổ biến tại Việt Nam", "Điền model, RAM, Android/API, hãng", "Chạy đủ E2E", "GATE-G07, COMP-H01", "Placeholder bắt buộc thay"],
  ["Thiết bị", "DEV-AND-02", "Android khác hãng/OS", "Điền model, RAM, Android/API, hãng", "Chạy đủ E2E", "COMP-H01", "Placeholder bắt buộc thay"],
  ["Thiết bị", "DEV-IOS-01", "iPhone thật", "Điền model/iOS và build iOS", "Chạy đủ E2E", "GATE-G07, COMP-H02", "APK không áp dụng"],
  ["Môi trường", "ENV-QUIET", "Phòng yên tĩnh", "Ghi dBA nền, khoảng cách, hướng nói", "Baseline", "Voice/Audio", "Không dùng cảm tính thay số đo nếu có thiết bị"],
  ["Môi trường", "ENV-HOME", "Gia đình bình thường", "TV nhỏ, người đi lại", "Không mất từ/nhầm nguồn thường xuyên", "Voice/Audio/UAT", "Ghi dBA"],
  ["Môi trường", "ENV-TV", "TV có lời thoại", "Trẻ im lặng rồi nói xen kẽ", "Không nhận TV là trẻ", "GATE-G05, VOICE-G04", ""],
  ["Môi trường", "ENV-ADULT", "Người lớn nói chen", "Người lớn gần/xa thiết bị", "Không nhận nhầm là lệnh trẻ", "GATE-G06, VOICE-G04", ""],
  ["Môi trường", "ENV-CLASS", "Tiếng lớp học", "Nhiều giọng và chuyển động", "Câu cốt lõi vẫn dùng được", "HW-C08, VOICE-G04", "Ghi dBA"],
  ["Mạng", "NET-WIFI", "Wi-Fi tốt", "Ghi latency/bandwidth/loss", "Baseline", "E06/H05", ""],
  ["Mạng", "NET-MOBILE", "Dữ liệu di động", "Ghi nhà mạng và signal", "So sánh Wi-Fi", "A05/E06", ""],
  ["Mạng", "NET-WEAK", "Mạng yếu", "Ngưỡng cần QA phê duyệt", "Thông báo/retry rõ", "A05/E07/H06", ""],
  ["Mạng", "NET-OFFLINE", "Mất mạng hoàn toàn", "Tắt cả Wi-Fi/mobile", "Không báo thành công; không quay vô hạn", "E07/H06", ""],
  ["Mạng", "NET-RECOVERY", "Mất rồi có lại giữa giao dịch", "Khôi phục sau 10-30 giây", "Tiếp tục được; không trùng dữ liệu", "H06", ""],
  ["Bluetooth", "BT-PAIR", "Find/pair/unpair/re-pair", "Android + iPhone", "Tên rõ; không nhầm thiết bị", "B01", ""],
  ["Bluetooth", "BT-HFP-MIC", "Đối chứng nguồn micro", "Che micro phone/đặt xa/đưa thiết bị gần", "Audio input từ thiết bị", "GATE-G01/B02", ""],
  ["Bluetooth", "BT-HFP-SPK", "Đối chứng nguồn loa", "Che loa phone/đổi volume", "TTS từ loa thiết bị", "GATE-G01/B03", ""],
  ["Bluetooth", "BT-RECONNECT", "BT off/on, out-of-range, background", "Tách thời gian HFP và BLE", "Phục hồi theo thiết kế", "G02/B10", ""],
  ["Lệnh", "CMD-LEARN-01", "Học bài", "Nhấn MAIN rồi nói", "Intent học theo chủ đề", "G04/D04", ""],
  ["Lệnh", "CMD-LEARN-02", "Học theo chủ đề", "Nhấn MAIN rồi nói", "Intent học theo chủ đề", "G04/D04", ""],
  ["Lệnh", "CMD-LEARN-03", "Học khóa học", "Nhấn MAIN rồi nói", "Intent học theo chủ đề", "D04", ""],
  ["Lệnh", "CMD-LEARN-04", "Bắt đầu bài học", "Nhấn MAIN rồi nói", "Intent học theo chủ đề", "D04", ""],
  ["Lệnh", "CMD-NEW-01", "Học từ mới", "Nhấn MAIN rồi nói", "Intent học từ mới", "G04/D05", ""],
  ["Lệnh", "CMD-NEW-02", "Học từ", "Nhấn MAIN rồi nói", "Intent học từ mới", "D05", ""],
  ["Lệnh", "CMD-NEW-03", "Luyện từ", "Nhấn MAIN rồi nói", "Intent học từ mới", "D05", ""],
  ["Lệnh", "CMD-TRANS-01", "Dịch tiếng Anh", "Nhấn MAIN rồi nói", "Intent dịch", "G04/D06", ""],
  ["Lệnh", "CMD-TRANS-02", "Con muốn dịch", "Nhấn MAIN rồi nói", "Intent dịch", "D06", ""],
  ["Lệnh", "CMD-TRANS-03", "Dịch một câu", "Nhấn MAIN rồi nói", "Intent dịch từng câu", "D06", ""],
  ["Lệnh", "CMD-TRANS-04", "Dịch liên tục", "Nhấn MAIN rồi nói", "Intent dịch liên tục", "D06", ""],
  ["Lệnh", "CMD-NAV-01", "Câu tiếp theo / Câu trước / Nghe lại", "Trong bài", "Điều khiển đúng cấp câu", "D07", ""],
  ["Lệnh", "CMD-NAV-02", "Bài tiếp theo / Bài trước", "Trong bài", "Điều khiển đúng cấp bài", "D08", ""],
  ["Lệnh", "CMD-STOP-01", "Dừng lại", "Trong dịch liên tục", "Dừng và không thu tiếp", "E04", ""],
  ["Negative", "NEG-NO-SPEECH", "Im lặng hai cửa sổ nghe", "Khoảng 6 giây mỗi lần", "Nhắc 1 lần rồi thoát", "D02", ""],
  ["Negative", "NEG-GIBBERISH", "Câu vô nghĩa/không thuộc từ điển", "Âm lượng bình thường", "Fallback, không nhảy module", "D03", ""],
  ["Negative", "NEG-LOW-CONF", "Nói nhỏ/không rõ", "Giữ audio để phân tích", "Hướng dẫn nói lại", "D03", ""],
  ["Dịch", "TR-CORE-01", "Mẹ ơi, con muốn mua cái này", "Giọng trẻ, một câu", "Giữ xưng hô và nhu cầu", "E02/G07", "Case nguồn điển hình"],
  ["Dịch", "TR-CORE-02", "Con không muốn ăn món này", "Kiểm tra phủ định", "Giữ chủ ngữ và phủ định", "E02", ""],
  ["Dịch", "TR-CORE-03", "Bố ơi, con cần đi vệ sinh", "Kiểm tra xưng hô/nhu cầu", "Ngắn, an toàn, đúng nghĩa", "E02", ""],
  ["Dịch", "TR-CORE-04", "Con bị đau ở đây", "Ngữ cảnh nhạy cảm", "Không thêm/chẩn đoán sai", "E02/F10", "Cần policy nội dung"],
  ["Dịch", "TR-SLOW-01", "Mẹ ơi... con muốn... mua cái này", "Dừng 0,5-2 giây", "Không cắt sớm", "E05", ""],
  ["Tuổi", "AGE-LOW", "Tuổi thấp nhất hỗ trợ", "Theo định nghĩa sản phẩm", "Nội dung phù hợp", "F01", "Cần PO xác nhận"],
  ["Tuổi", "AGE-BOUNDARY", "Tuổi tại ranh giới hai nhóm", "Test hai phía ranh giới", "Mapping nhất quán", "F01", "Cần PO xác nhận"],
  ["Tuổi", "AGE-HIGH", "Tuổi cao nhất hỗ trợ", "Theo định nghĩa sản phẩm", "Nội dung phù hợp", "F01", "Cần PO xác nhận"],
  ["Nội dung", "CONTENT-WORD", "Một từ đơn phổ biến", "Phụ huynh thêm", "Khớp câu đã duyệt", "F07/F08", ""],
  ["Nội dung", "CONTENT-UNKNOWN-01", "Từ hiếm không có trong kho", "Phụ huynh thêm", "Chờ xác nhận, không tự sinh sai", "F08", ""],
  ["An toàn", "SAFE-PROFANITY", "Từ tục/xúc phạm", "Dùng dữ liệu giả lập tối thiểu", "Chặn/phản hồi an toàn", "F10", "Không lưu trong tài liệu chia sẻ rộng"],
  ["An toàn", "SAFE-SEXUAL", "Nội dung tình dục", "Dữ liệu kiểm soát", "Không đưa tới trẻ", "F10", ""],
  ["An toàn", "SAFE-VIOLENCE", "Nội dung bạo lực/đẫm máu", "Dữ liệu kiểm soát", "Không đưa tới trẻ", "F10", ""],
  ["Voice cohort", "VOICE-B/N/T", "Mẫu Bắc/Trung/Nam", "Mã ẩn danh + consent", "Kết quả tách theo vùng", "G01-G04", "Không ghi PII"],
  ["Interrupt", "INT-BG", "App background/foreground", "60 giây", "Phục hồi rõ", "H03", ""],
  ["Interrupt", "INT-LOCK", "Khóa/mở màn hình", "30 giây", "Không lỗi im lặng", "H03", ""],
  ["Interrupt", "INT-CALL", "Cuộc gọi đến", "Trong ghi/phát/dịch", "Audio route phục hồi", "H03/H07", ""],
  ["UAT", "UAT-CHILD-01", "Trẻ tự dùng không cầm điện thoại", "Có giám sát + consent", "Hoàn thành luồng cốt lõi", "I01/I04/I07", "Dừng nếu trẻ khó chịu"],
  ["UAT", "UAT-PARENT-01", "Thiết lập và quản lý phụ huynh", "Kết nối/tuổi/nội dung/lịch sử/quyền", "Vai trò rõ", "I02/I06", ""],
];
const dataLastRow = 5 + testDataRows.length;
dataSheet.getRange(`A6:G${dataLastRow}`).values = testDataRows;
setBody(dataSheet.getRange(`A6:G${dataLastRow}`), 42);
const dataTable = dataSheet.tables.add(`A5:G${dataLastRow}`, true, "AIV1TestData");
dataTable.style = "TableStyleMedium2";
for (const [col, width] of Object.entries({ A: 16, B: 20, C: 42, D: 45, E: 46, F: 24, G: 38 })) setColumnWidth(dataSheet, col, width, dataLastRow);
dataSheet.freezePanes.freezeRows(5);
dataSheet.freezePanes.freezeColumns(2);

// Defect log
setTitle(defectSheet, "A1:O1", "DEFECT LOG", "A2:O2", "Mọi test case Không đạt phải có Defect ID, bước tái hiện, môi trường, bằng chứng và owner. Không dùng mô tả chung chung như 'dịch không chính xác'.");
const defectHeaders = ["Defect ID", "Related TC", "Requirement", "Tóm tắt", "Severity", "Priority", "Status", "Repro rate", "Môi trường", "Bước tái hiện", "Actual", "Expected", "Evidence", "Owner", "Target date"];
defectSheet.getRange("A5:O5").values = [defectHeaders];
setHeader(defectSheet.getRange("A5:O5"));
const reservedDefectRows = Array.from({ length: 25 }, () => Array(15).fill(""));
defectSheet.getRange("A6:O30").values = reservedDefectRows;
setBody(defectSheet.getRange("A6:O30"), 54);
defectSheet.getRange("E6:E30").dataValidation = { rule: { type: "list", values: ["S0-Critical", "S1-High", "S2-Medium", "S3-Low"] } };
defectSheet.getRange("F6:F30").dataValidation = { rule: { type: "list", values: ["P0", "P1", "P2"] } };
defectSheet.getRange("G6:G30").dataValidation = { rule: { type: "list", values: ["New", "Assigned", "Fixed", "Ready for Retest", "Reopened", "Closed", "Deferred"] } };
defectSheet.getRange("O6:O30").format.numberFormat = "yyyy-mm-dd";
defectSheet.getRange("A6:O30").format.fill = "#FFFDF2";
const defectTable = defectSheet.tables.add("A5:O30", true, "AIV1Defects");
defectTable.style = "TableStyleMedium2";
for (const [col, width] of Object.entries({ A: 16, B: 18, C: 18, D: 38, E: 16, F: 12, G: 20, H: 14, I: 38, J: 55, K: 45, L: 45, M: 28, N: 18, O: 14 })) setColumnWidth(defectSheet, col, width, 30);
defectSheet.freezePanes.freezeRows(5);
defectSheet.freezePanes.freezeColumns(3);

// Compact QA inspections
const inspectSummary = await workbook.inspect({ kind: "table", range: "Tong quan!A1:G17", include: "values,formulas", tableMaxRows: 20, tableMaxCols: 10, maxChars: 7000 });
console.log("SUMMARY_INSPECT\n" + inspectSummary.ndjson);
const inspectCases = await workbook.inspect({ kind: "table", range: `Test Cases!A1:U12`, include: "values,formulas", tableMaxRows: 14, tableMaxCols: 21, maxChars: 10000 });
console.log("CASES_INSPECT\n" + inspectCases.ndjson);
const inspectTrace = await workbook.inspect({ kind: "table", range: "Truy vet!A1:J12", include: "values,formulas", tableMaxRows: 14, tableMaxCols: 12, maxChars: 9000 });
console.log("TRACE_INSPECT\n" + inspectTrace.ndjson);
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 300 }, summary: "final formula error scan", maxChars: 5000 });
console.log("ERROR_SCAN\n" + errors.ndjson);

const previews = [
  ["Tong quan", "A1:G17", "01_tong_quan.png"],
  ["Cau hinh", "A1:D25", "02_cau_hinh.png"],
  ["Phan tich", `A1:F${strategyStart + strategyRows.length}`, "03_phan_tich.png"],
  ["Test Cases", "A1:U24", "04_test_cases.png"],
  ["Truy vet", "A1:J24", "05_truy_vet.png"],
  ["Du lieu test", `A1:G${dataLastRow}`, "06_du_lieu_test.png"],
  ["Defect Log", "A1:O20", "07_defect_log.png"],
];
for (const [sheetName, range, fileName] of previews) {
  const blob = await workbook.render({ sheetName, range, scale: 1, format: "png" });
  await fs.writeFile(path.join(qaDir, fileName), new Uint8Array(await blob.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, requirementCount: requirements.length, testCaseCount: testCases.length, tcLastRow, traceLastRow, dataLastRow }, null, 2));
