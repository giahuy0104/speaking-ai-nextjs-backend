import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = process.argv[2];
const previewDir = process.argv[3];
if (!outputDir || !previewDir) throw new Error("Missing output or preview directory");
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const wb = Workbook.create();
const dashboard = wb.worksheets.add("Dashboard");
const tcSheet = wb.worksheets.add("Test Cases");
const voiceSheet = wb.worksheets.add("Voice Matrix");
const childSheet = wb.worksheets.add("Child Plan");
const deviceSheet = wb.worksheets.add("Device Matrix");
const executionSheet = wb.worksheets.add("Execution Log");
const criteriaSheet = wb.worksheets.add("Acceptance");
const findingSheet = wb.worksheets.add("Initial Findings");

const C = {
  navy: "#12305B", blue: "#3159D9", teal: "#0F718C", cyan: "#DDF3FA",
  sky: "#EEF7FB", pale: "#F6F8FC", white: "#FFFFFF", text: "#14213D",
  muted: "#5D6B82", green: "#DCFCE7", greenText: "#166534", red: "#FEE2E2",
  redText: "#B91C1C", amber: "#FEF3C7", amberText: "#92400E", line: "#CBD5E1",
  purple: "#EDE9FE", purpleText: "#6D28D9",
};

function title(sheet, range, text, subtitleRange, subtitle) {
  sheet.showGridLines = false;
  sheet.getRange(range).merge();
  sheet.getRange(range).values = [[text]];
  sheet.getRange(range).format = {
    fill: C.navy, font: { bold: true, color: C.white, size: 18 },
    verticalAlignment: "center", horizontalAlignment: "left",
  };
  sheet.getRange(range).format.rowHeight = 34;
  if (subtitleRange) {
    sheet.getRange(subtitleRange).merge();
    sheet.getRange(subtitleRange).values = [[subtitle]];
    sheet.getRange(subtitleRange).format = {
      fill: "#E8EFFC", font: { italic: true, color: C.navy, size: 10 },
      verticalAlignment: "center", wrapText: true,
    };
    sheet.getRange(subtitleRange).format.rowHeight = 26;
  }
}

function header(range, fill = C.teal) {
  range.format = {
    fill, font: { bold: true, color: C.white },
    horizontalAlignment: "center", verticalAlignment: "center", wrapText: true,
    borders: { preset: "outside", style: "thin", color: C.line },
  };
  range.format.rowHeight = 28;
}

function body(range) {
  range.format = {
    font: { color: C.text, size: 10 }, verticalAlignment: "top", wrapText: true,
    borders: {
      insideHorizontal: { style: "thin", color: "#DDE6F0" },
      insideVertical: { style: "thin", color: "#EDF2F7" },
    },
  };
}

const tcs = [];
function add(group, feature, scenario, pre, steps, data, repeats, expected, metric, priority = "P1", type = "Functional", owner = "QA") {
  tcs.push({ id: `TC-${String(tcs.length + 1).padStart(3, "0")}`, group, feature, scenario, pre, steps, data, repeats, expected, metric, priority, type, owner });
}
const appReady = "APK release candidate đã cài; quyền cần thiết được cấp; backend production khả dụng trừ khi test yêu cầu khác.";
const h20Ready = "Điện thoại Android thật đã ghép đôi H20; ghi rõ H20 ID, firmware, pin; ENABLE_HFP_AUDIO=true.";

// Cài đặt, Android và vòng đời.
add("Cài đặt & Android", "Cài mới", "Cài APK trên Android 7/API 24", "Máy sạch, chưa có ứng dụng", "1. Cài APK\n2. Mở app\n3. Cấp quyền", "Android 7/API 24", 3, "Cài và mở thành công; không crash; giao diện dùng được.", "3/3 lần đạt", "P0", "Compatibility");
add("Cài đặt & Android", "Nâng cấp", "Nâng từ build trước và giữ dữ liệu học", "Có tiến độ, Ngôi sao, Luyện lại và lịch sử", "1. Cài đè build mới\n2. Mở lại\n3. Đối chiếu dữ liệu", "Build cũ → 1.0.4+8", 3, "Không mất hoặc nhân đôi dữ liệu người học.", "100% dữ liệu giữ đúng", "P0", "Regression");
add("Cài đặt & Android", "Quyền micro", "Cho phép quyền micro", "Cài mới", "Mở app; chọn Cho phép; bắt đầu một lượt nói", "RECORD_AUDIO=Allow", 3, "Micro khởi tạo và thu được giọng nói.", "3/3 lần đạt", "P0", "Permission");
add("Cài đặt & Android", "Quyền micro", "Từ chối quyền micro", "Cài mới", "Từ chối quyền; nhấn Main; mở bài cần ghi âm", "RECORD_AUDIO=Deny", 3, "Không crash; hướng dẫn cấp quyền; không hiển thị đang ghi giả.", "0 crash", "P0", "Negative");
add("Cài đặt & Android", "Bluetooth", "Từ chối Nearby devices trên Android 12+", "Android 12+; H20 bật", "Từ chối BLUETOOTH_SCAN/CONNECT; mở chẩn đoán H20", "Permission=Deny", 3, "App giải thích đúng; phần học bằng mic điện thoại vẫn dùng được.", "0 crash", "P0", "Permission");
add("Cài đặt & Android", "Lifecycle", "Đưa app xuống nền khi đang nghe", appReady, "Mở micro; bấm Home; chờ 15 giây; quay lại", "Foreground → background", 10, "Dừng/giải phóng micro; quay lại không có phiên ma.", "0 phiên micro ma", "P0", "Recovery");
add("Cài đặt & Android", "Lifecycle", "Tắt màn hình khi đang nghe", appReady, "Mở micro; khóa màn hình; nói; mở lại", "Screen off 15 giây", 10, "Không tiếp tục nghe khi màn hình tắt; khôi phục an toàn.", "10/10 lần đạt", "P0", "Recovery");
add("Cài đặt & Android", "Cập nhật", "Build thấp hơn minimum version", "Backend trả chính sách bắt buộc cập nhật", "Mở app bằng build cũ", "Update gate", 3, "Hiện màn hình chặn cập nhật; không vào luồng học lỗi thời.", "3/3 lần đạt", "P1", "Functional");

// Main và điều phối audio/micro.
add("Main & Bi cô", "Hiển thị", "Main cố định trên các màn hình chính", appReady, "Mở Giao tiếp, Từ vựng, Chủ đề, danh sách bài, bài học", "5 màn hình", 3, "Main nhìn thấy, không che thao tác quan trọng.", "0 màn hình bị che", "P1", "Usability");
add("Main & Bi cô", "Nhấn ngắn", "Mở menu trợ lý từ trạng thái rảnh", appReady, "Nhấn Main; nghe hết lời nhắc; chờ tiếng tít", "Tap Main", 10, "Chỉ một lời nhắc; tiếng tít phát sau lời nói; micro mở sau tít.", "10/10; 0 chồng âm", "P0");
add("Main & Bi cô", "Chống chồng", "Nhấn Main hai lần trong 300 ms", appReady, "Double tap Main; quan sát TTS, micro và overlay", "Double tap", 30, "Chỉ một phiên trợ lý và một phiên micro.", "0/30 phiên trùng", "P0", "Concurrency");
add("Main & Bi cô", "Chống chồng", "Nhấn Main khi Bi cô đang nói", appReady, "Nhấn Main; trong lúc TTS đang phát nhấn lại", "Tap during TTS", 30, "Không mở ASR trước khi TTS/beep kết thúc; không tự nghe tiếng loa.", "0/30 self-capture", "P0", "Concurrency");
add("Main & Bi cô", "Chống chồng", "Nhấn Main khi backend đang xử lý", appReady, "Nói câu; trong phase processing nhấn Main nhiều lần", "Latency 2–5 giây", 20, "Trả busy/khóa an toàn; không tạo request trùng.", "1 request/lượt", "P0", "Concurrency");
add("Main & Bi cô", "Im lặng", "Im lặng ở cửa sổ lệnh đầu", appReady, "Nhấn Main; sau tít im lặng ≥6 giây", "No speech", 10, "Bi cô hỏi lại đúng một lần ‘Con muốn làm gì?’.", "10/10 đúng", "P0", "Timeout");
add("Main & Bi cô", "Im lặng", "Tiếp tục im lặng sau lần hỏi lại", appReady, "Im lặng trong cả hai cửa sổ nghe", "No speech x2", 10, "Đóng phiên; Main trở lại bình thường; micro được giải phóng.", "10/10 đúng", "P0", "Timeout");
add("Main & Bi cô", "Nhấn giữ", "Nhấn giữ lần một trong bài học", "Đang phát hoặc ghi âm trong bài học", "Nhấn giữ Main", "Long press", 20, "Dừng đúng hành động hiện tại; nói ‘Đã dừng’; giữ nguyên bài/câu.", "20/20; không đổi route", "P0");
add("Main & Bi cô", "Nhấn giữ", "Nhấn giữ lần hai để học tiếp", "Bài học đang paused bởi Main", "Nhấn giữ Main lần hai", "Long press resume", 20, "Nói ‘Cùng học tiếp nhé’; tự mở lượt ghi âm mới.", "20/20 micro mở", "P0");
add("Main & Bi cô", "Release", "Release sau long press", "Vừa nhấn giữ Main", "Thả nút; quan sát trạng thái", "Release gesture", 30, "Release không tạo hành động dừng/khởi động lần hai.", "0 hành động kép", "P0", "Concurrency");
add("Main & Bi cô", "Lệnh trong bài", "Nói tiếp tục/nghe lại/câu sau/câu trước", "Bài học tạm dừng để nghe lệnh", "Thử từng lệnh sau tiếng tít", "4 lệnh", 5, "Thực hiện đúng lệnh và chỉ thay đổi đúng phạm vi.", "≥95% intent đúng", "P0", "Voice intent");
add("Main & Bi cô", "Lệnh trong bài", "Nói dừng lại", "Đang học bài", "Nhấn Main; nói ‘Dừng lại’", "Stop command", 10, "Đóng hoạt động học và về đúng màn hình quy định.", "10/10 đúng", "P1", "Voice intent");
add("Main & Bi cô", "Tín hiệu tít", "Kiểm tra tất cả lời nói của Bi cô có beep", appReady, "Chạy menu, hỏi tuổi, chọn chủ đề/bài, retry, goodbye", "Danh sách prompt", 3, "Beep chỉ phát sau khi prompt kết thúc và trước khi nghe trẻ.", "100% prompt cần phản hồi", "P0", "Audio timing");

// Điều hướng giọng nói.
add("Điều hướng AI", "Menu", "Chọn học theo chủ đề", appReady, "Nhấn Main; nói ‘Con muốn học theo chủ đề’", "Câu chuẩn + 3 biến thể", 5, "Chuyển sang hỏi tuổi, không mở sai chức năng.", "≥95%", "P0", "Voice intent");
add("Điều hướng AI", "Menu", "Chọn học từ mới", appReady, "Nhấn Main; nói ‘Con muốn học từ mới’", "Câu chuẩn + 3 biến thể", 5, "Mở Từ vựng đúng một lần.", "≥95%", "P0", "Voice intent");
add("Điều hướng AI", "Menu", "Chọn dịch một câu", appReady, "Nhấn Main; chọn dịch; nói ‘một câu’", "One sentence", 5, "Mở đúng chế độ dịch một câu.", "≥95%", "P0", "Voice intent");
add("Điều hướng AI", "Menu", "Chọn dịch liên tục", appReady, "Nhấn Main; chọn dịch; nói ‘dịch liên tục’", "Continuous", 5, "Mở chế độ liên tục và tự chuẩn bị lượt mới.", "≥95%", "P0", "Voice intent");
add("Điều hướng AI", "Tuổi", "Nhận tuổi bằng số và chữ", appReady, "Lần lượt nói ‘Con 6 tuổi’, ‘Con sáu tuổi’", "4,6,9,11,14 tuổi", 5, "Chọn đúng nhóm 3–5, 6–7, 8–10, 11–12, 13–15.", "≥95%", "P0", "Boundary");
add("Điều hướng AI", "Tuổi", "Tuổi ngoài phạm vi", appReady, "Nói 2 tuổi và 16 tuổi", "2;16", 5, "Không chọn sai nhóm; nhắc phạm vi hợp lệ và nghe lại.", "10/10 đúng", "P1", "Negative");
add("Điều hướng AI", "Chủ đề", "Chọn chủ đề bằng số/chữ", appReady, "Nói ‘chủ đề số 3’, ‘chủ đề ba’", "1–10", 5, "Mở đúng chủ đề; số lượng chủ đề đọc theo dữ liệu.", "≥95%", "P0", "Voice intent");
add("Điều hướng AI", "Chủ đề", "Chọn chủ đề ngoài phạm vi", appReady, "Nói chủ đề 0 và 11", "0;11", 5, "Không mở nhầm; nhắc chọn 1–10.", "10/10 đúng", "P1", "Negative");
add("Điều hướng AI", "Học lại", "Chọn chủ đề đã hoàn thành và nói Có", "Có chủ đề đã hoàn thành", "Chọn chủ đề; nghe xác nhận; nói Có", "Affirmative variants", 5, "Hỏi số bài và mở bài được chọn.", "5/5 đúng", "P0", "Regression");
add("Điều hướng AI", "Học lại", "Chọn chủ đề đã hoàn thành và nói Không", "Có chủ đề đã hoàn thành", "Chọn chủ đề; nói Không", "Negative variants", 5, "Quay lại hỏi trong toàn bộ N chủ đề.", "5/5 đúng", "P0", "Regression");
add("Điều hướng AI", "Fallback", "Lệnh không liên quan hoặc nghe không rõ", appReady, "Nói câu ngoài menu hoặc nhiễu", "Con muốn ăn cơm; âm không rõ", 10, "Không điều hướng sai; nhắc lại lựa chọn.", "False route ≤1%", "P0", "Negative");
add("Điều hướng AI", "Đa giọng", "Giọng Bắc/Trung/Nam", appReady, "Mỗi trẻ nói bộ lệnh chuẩn", "3 vùng giọng", 5, "Không thiên lệch rõ rệt giữa nhóm giọng.", "Chênh lệch nhóm ≤10 điểm %", "P1", "Field");

// Dịch và luyện nói.
add("Dịch & Luyện nói", "Một câu", "Nhận diện–dịch–hiển thị–phát âm", appReady, "Nói câu tiếng Việt; dừng; chờ kết quả", "10 câu ngắn/dài", 5, "Hiện câu gốc và tiếng Anh; audio đúng nội dung.", "≥95% luồng hoàn tất", "P0", "End-to-end");
add("Dịch & Luyện nói", "Liên tục", "Tự mở lượt tiếp theo sau playback", appReady, "Hoàn thành một lượt; không chạm Main; nói câu tiếp", "5 câu liên tiếp", 10, "Mỗi lượt độc lập; chỉ một micro; không mất câu.", "0 chồng/50 lượt", "P0", "Concurrency");
add("Dịch & Luyện nói", "Im lặng", "Không nói trong 10 giây", appReady, "Vào liên tục; im lặng ≥10 giây", "No speech", 10, "Nói ‘tạm biệt con nhé’; thoát chế độ; Main reset.", "10/10 đúng", "P0", "Timeout");
add("Dịch & Luyện nói", "Đổi chức năng", "Nói ‘Còn cái gì khác để học không?’", "Đang chờ câu dịch", "Nói lệnh đổi chức năng", "Command during speaking", 10, "Không dịch câu lệnh; hỏi chọn nội dung khác.", "10/10 đúng", "P0", "Voice intent");
add("Dịch & Luyện nói", "Nói nhanh", "Câu tiếng Việt tốc độ 130–160 từ/phút", appReady, "Nói bộ 10 câu nhanh ở 0,5 m", "Fast speech", 5, "Không mất âm đầu/cuối; nghĩa dịch đúng.", "Intent/meaning ≥90%", "P0", "Field");
add("Dịch & Luyện nói", "Nói chậm", "Câu 60–80 từ/phút, có khoảng dừng", appReady, "Nói bộ 10 câu chậm; dừng 0,5 giây", "Slow speech", 5, "VAD không cắt câu quá sớm; kết quả đủ ý.", "Meaning ≥90%", "P0", "Field");
add("Dịch & Luyện nói", "Giọng nhỏ", "Giọng nhỏ ở 0,5 m", appReady, "Nói 10 câu với âm lượng nhỏ tự nhiên", "45–50 dBA", 5, "Nhận diện được hoặc yêu cầu nói lại, không tạo câu giả.", "False transcript ≤2%", "P1", "Field");
add("Dịch & Luyện nói", "Mạng chậm", "Latency 500–1000 ms và packet loss 5%", appReady, "Giả lập mạng; hoàn thành 10 lượt", "Weak Wi-Fi/4G", 5, "Không treo; timeout/retry hữu hạn; thông báo thân thiện.", "0 treo; ≥90% hoàn tất", "P0", "Resilience");
add("Dịch & Luyện nói", "Mất mạng", "Mất mạng sau khi ghi âm", appReady, "Bắt đầu ghi; tắt mạng; hoàn tất lượt", "Offline mid-turn", 10, "Không hiện lỗi kỹ thuật thô; cho phép thử lại.", "0 Format/Socket exception thô", "P0", "Negative");
add("Dịch & Luyện nói", "Backend", "HTTP 404/HTML thay vì JSON", appReady, "Dùng response mock/route thiếu", "Server action not found", 5, "Parse an toàn; thông báo thân thiện; không crash.", "5/5 đúng", "P0", "Negative");

// Chủ đề và bài học.
add("Chủ đề & Bài học", "Nội dung", "Đủ 5 nhóm tuổi và 50 chủ đề", appReady, "Mở từng tab tuổi; đếm chủ đề", "3–5;6–7;8–10;11–12;13–15", 1, "Mỗi nhóm có 10 chủ đề; tổng 50.", "50/50 đúng", "P0", "Data integrity");
add("Chủ đề & Bài học", "Nội dung", "Đủ bài học và bài hát", appReady, "Đối chiếu catalog", "101 bài; 11 bài hát; 744 câu", 1, "Không thiếu/trùng ID; audio mapping hợp lệ.", "100% catalog", "P0", "Data integrity");
add("Chủ đề & Bài học", "Intro", "Mở bài qua trợ lý và phát introAudioUrl", appReady, "Điều hướng bằng Main vào bài; nghe intro", "Bài My Name và mẫu mỗi nhóm tuổi", 3, "Phát đúng file introAudioUrl; không dùng TTS thay thế.", "100% mẫu đạt", "P0", "Regression");
add("Chủ đề & Bài học", "Intro", "introAudioUrl lỗi hoặc null", appReady, "Mở bài có URL lỗi/null", "404/null", 3, "Không tự đọc bằng TTS; hiện lỗi/Bỏ qua theo thiết kế; không auto advance sai.", "0 crash", "P0", "Negative");
add("Chủ đề & Bài học", "Ghi âm", "Tự dừng sau tối đa 6 giây", "Đang ở câu luyện", "Bắt đầu ghi; nói; chờ", "Utterance <6 giây", 10, "Dừng đúng một lần và chuyển đánh giá.", "10/10 đúng", "P0", "Timing");
add("Chủ đề & Bài học", "Câu đúng", "Nói đúng Hello không phân biệt hoa/thường", "Expected=Hello!", "Nói hello/HELLO với ngữ điệu khác", "5 biến thể", 5, "Chúc mừng ‘Con làm tốt lắm’; không yêu cầu tập trung.", "≥95%", "P0", "ASR accuracy");
add("Chủ đề & Bài học", "Câu đúng", "Nói đúng I’m An với biến thể ASR", "Expected=I'm An", "Nói I’m An/I am An/im an", "5 biến thể", 5, "Chuẩn hóa dấu câu/case; đánh giá đúng.", "≥95%", "P0", "ASR accuracy");
add("Chủ đề & Bài học", "Câu sai", "Nói tiếng Việt thay cho câu tiếng Anh", "Expected=I'm An", "Nói ‘Con muốn ăn cơm’", "Wrong language", 5, "Nói ‘Con tập trung học đi’; tự mở ghi âm lại.", "5/5 retry mở", "P0", "Negative");
add("Chủ đề & Bài học", "Retry", "Sai lần hai", "Đã sai lần một", "Nói sai lần hai", "Wrong x2", 5, "Nói ‘Mình cùng học câu khác nhé!’ và chuyển câu theo thiết kế.", "5/5 đúng", "P0", "Regression");
add("Chủ đề & Bài học", "Không rõ", "Im lặng hoặc âm quá nhỏ", "Đang ghi câu", "Im lặng/âm nhiễu", "No/unclear speech", 10, "Không tính là câu sai có nghĩa; nhắc nói lại phù hợp.", "0 false-wrong", "P0", "Negative");
add("Chủ đề & Bài học", "Ngôi sao", "Câu đúng được lưu một lần", "Nói đúng câu", "Hoàn tất; mở Từ vựng > Ngôi sao", "Same sentence repeated", 5, "Câu xuất hiện; không trùng bản ghi.", "1 entry/câu", "P0", "Data persistence");
add("Chủ đề & Bài học", "Luyện lại", "Câu sai được lưu vào Luyện lại", "Nói sai câu", "Hoàn tất retry; mở Luyện lại", "Wrong attempt", 5, "Đúng câu và metadata bài học được lưu.", "1 entry/câu", "P0", "Data persistence");
add("Chủ đề & Bài học", "Tiến độ", "Thoát và vào lại giữa bài", "Đã học một số câu", "Thoát; đóng app; mở lại bài", "Resume progress", 5, "Khôi phục đúng câu/tiến độ, không nhảy lùi.", "5/5 đúng", "P0", "Persistence");
add("Chủ đề & Bài học", "Cuối bài", "Nói bài tiếp theo khi còn bài", "Hoàn thành bài không phải cuối", "Chọn ‘bài tiếp theo’", "Next lesson", 5, "Mở đúng bài kế tiếp và phát đúng intro.", "5/5 đúng", "P0", "End-to-end");
add("Chủ đề & Bài học", "Cuối bài", "Nói bài tiếp theo tại bài cuối", "Hoàn thành bài cuối", "Chọn bài tiếp theo", "End of topic", 5, "Thông báo hoàn thành; về danh sách chủ đề; hỏi chọn trong N chủ đề.", "5/5 đúng", "P0", "Regression");
add("Chủ đề & Bài học", "Cuối bài", "Lựa chọn cuối bài nghe không rõ", "Đang ở lựa chọn cuối bài", "Nói âm không rõ", "Unclear choice", 5, "Nói ‘Nói lại lựa chọn của con nhé’ và nghe lại.", "5/5 đúng", "P0", "Negative");
add("Chủ đề & Bài học", "Bài hát", "Phát bài hát/chant và điều khiển playback", appReady, "Mở một bài hát; play/pause/replay/thoát", "11 songs sampling", 3, "Audio đúng; không phát chồng; thoát giải phóng playback.", "0 audio overlap", "P1", "Media");

// Từ vựng, lịch sử, cài đặt.
add("Từ vựng & Cài đặt", "Từ vựng", "Mở Gia đình/Ngôi sao/Luyện lại", appReady, "Mở lần lượt ba hành trình", "3 journeys", 3, "Đúng danh sách và số lượng; không trộn trạng thái.", "3/3 đúng", "P1", "Functional");
add("Từ vựng & Cài đặt", "Từ vựng", "Thêm, tìm kiếm, phát âm và xóa từ", appReady, "Thêm từ; tìm; play; bật xóa; xóa", "Family/School/Happy", 3, "CRUD đúng; audio chỉ phát một lần.", "3/3 đúng", "P1", "Functional");
add("Từ vựng & Cài đặt", "Từ vựng", "Dữ liệu tồn tại sau restart", "Có từ đã lưu", "Force stop; mở lại", "Persistence", 5, "Danh sách không mất hoặc trùng.", "5/5 đúng", "P0", "Persistence");
add("Từ vựng & Cài đặt", "Lịch sử", "Xem, lọc, xóa một mục", "Có lịch sử", "Mở Lịch sử; lọc; xóa một mục", "Approved/rejected", 3, "Hiển thị và cập nhật đúng.", "3/3 đúng", "P1", "Functional");
add("Từ vựng & Cài đặt", "Cài đặt", "Đổi sáng/tối/system", appReady, "Đổi theme; chuyển màn; restart", "3 themes", 3, "Áp dụng ngay và lưu lựa chọn.", "3/3 đúng", "P2", "Usability");
add("Từ vựng & Cài đặt", "Ngôn ngữ", "Đổi tiếng Việt/Trung", appReady, "Đổi ngôn ngữ; kiểm tra màn chính và cài đặt", "vi/zh", 3, "Chuỗi chính đổi đúng; không vỡ layout.", "0 text clipped nghiêm trọng", "P2", "Localization");
add("Từ vựng & Cài đặt", "Onboarding", "Lần đầu và không hiển thị lại sau hoàn thành", "Cài mới", "Đi hết tour; đóng/mở app", "First run", 3, "Tour đúng thứ tự; không lặp ngoài ý muốn.", "3/3 đúng", "P2", "Functional");

// H20 V1: HFP/SCO audio + BLE control.
add("H20 phần cứng", "BLE scan", "Quét thấy đúng H20", h20Ready, "Mở chẩn đoán; quét 8 giây; chọn H20", "1 m, line-of-sight", 30, "Tìm và hiển thị đúng tên/ID; không chọn nhầm.", "≥29/30", "P0", "Hardware");
add("H20 phần cứng", "BLE connect", "Kết nối và discover GATT 9E3B0001/2/3", h20Ready, "Kết nối; đọc service/characteristic", "Control GATT", 30, "Có service; Button Indicate+CCCD; APP State write-with-response.", "30/30 cấu trúc đúng", "P0", "Hardware");
add("H20 phần cứng", "Battery", "Đọc Battery 180F/2A19", h20Ready, "Kết nối; đọc pin; đối chiếu nhiều lần", "Pin 100/50/20/10%", 10, "Hiển thị % hợp lệ; không suy diễn đang sạc.", "Sai số theo firmware ≤5%", "P1", "Hardware");
add("H20 phần cứng", "Firmware", "Đọc Firmware Revision 180A/2A26", h20Ready, "Kết nối 5 H20; ghi firmware", "5 units", 3, "Chuỗi firmware đúng và truy vết được.", "100% đọc được", "P0", "Hardware");
add("H20 phần cứng", "HFP", "Hiển thị đúng HFP, micro và loa", h20Ready, "Kết nối; mở audio route; xem chẩn đoán", "HFP/SCO", 10, "Chỉ báo H20 khi Android xác nhận input/output route.", "0 khai báo sai", "P0", "Hardware");
add("H20 phần cứng", "Mic route", "Chứng minh dùng micro H20", h20Ready, "Đặt điện thoại xa/che mic; nói gần H20; loopback", "Phone 3 m; H20 0,3 m", 10, "Thu rõ từ H20; tên input là H20 Microphone.", "10/10", "P0", "Hardware");
add("H20 phần cứng", "Mic route", "Chứng minh không vô tình dùng mic điện thoại", h20Ready, "Nói gần điện thoại, giữ im lặng gần H20", "A/B route test", 10, "Kết quả phù hợp route H20, không nhận sai nguồn.", "0 fallback ẩn", "P0", "Hardware");
add("H20 phần cứng", "Speaker route", "Phát file asset offline qua loa H20", h20Ready, "Tắt Internet; phát Test loa offline", "Bundled MP3", 10, "Âm ra H20; người test xác nhận nghe được.", "10/10", "P0", "Hardware");
add("H20 phần cứng", "Loopback", "Thu tối đa 5 giây và phát lại offline", h20Ready, "Tắt mạng; ghi câu; tự phát lại", "5-second loopback", 10, "Không gọi cloud; tốc độ/cao độ tự nhiên.", "10/10; 0 network call", "P0", "Hardware");
add("H20 phần cứng", "MAIN", "Một short press tạo một sự kiện", "Protocol đã được ODM xác nhận và build bật flag", "Nhấn MAIN 100 lần, cách nhau 1 giây", "100 presses", 100, "Mỗi lần đúng một event/sequence; không duplicate action.", "≥99%; 0 double action", "P0", "Hardware reliability");
add("H20 phần cứng", "MAIN", "Double press nhanh", "Protocol confirmed", "Double press trong 300 ms, 30 vòng", "30 double presses", 30, "Coordinator không tạo hai phiên micro/TTS.", "0 overlap", "P0", "Concurrency");
add("H20 phần cứng", "MAIN", "Long press rồi release", "Protocol confirmed", "Long press 2 giây; thả; lặp 30", "Long/release", 30, "Dừng một lần; release không restart.", "30/30", "P0", "Hardware reliability");
add("H20 phần cứng", "Packet", "Packet trùng sequence", "Có công cụ/firmware tạo duplicate", "Gửi hai packet cùng sequence", "Duplicate packet", 20, "Packet sau bị bỏ qua; APP trả trạng thái duplicate nếu có.", "20/20 ignored", "P0", "Protocol");
add("H20 phần cứng", "Packet", "Packet version/length sai", "Có công cụ phát packet", "Gửi version khác 1 hoặc không đủ 12 byte", "Malformed packet", 20, "Chỉ log raw; không điều khiển app; không crash.", "20/20 safe", "P0", "Protocol");
add("H20 phần cứng", "APP State", "Ghi trạng thái 8 byte có response", "Protocol confirmed", "Chuyển idle/listening/processing/playing/error", "9E3B0003", 5, "H20 ACK đúng sequence; trạng thái không bị đảo.", "100% state ACK", "P0", "Protocol");
add("H20 phần cứng", "Reconnect", "Tắt/bật H20 khi app foreground", h20Ready, "Kết nối; tắt H20 10 giây; bật lại", "30 cycles", 30, "Tự reconnect hoặc cho kết nối lại; discover và subscribe Indicate lại.", "≥95% trong 10 giây", "P0", "Recovery");
add("H20 phần cứng", "Reconnect", "Ra ngoài phạm vi rồi quay lại", h20Ready, "Đi xa >10 m; chờ disconnect; quay về 1 m", "30 cycles", 30, "Không treo; route và MAIN hoạt động lại.", "≥95%", "P0", "Recovery");
add("H20 phần cứng", "Mất HFP", "BLE còn nhưng SCO mất", h20Ready, "Ngắt profile audio; giữ BLE", "Partial disconnect", 10, "Không khẳng định mic/loa H20; không ghi bằng route sai âm thầm.", "0 false route", "P0", "Recovery");
add("H20 phần cứng", "Mất BLE", "HFP còn nhưng BLE mất", h20Ready, "Ngắt BLE; thử audio và MAIN", "Partial disconnect", 10, "Audio được báo riêng; MAIN unavailable rõ ràng; không crash.", "10/10 safe", "P0", "Recovery");
add("H20 phần cứng", "Khoảng cách", "Nhận câu ở 0,3/0,5/1/2/3 m", h20Ready, "Mỗi trẻ nói bộ câu tại từng khoảng cách", "5 distances", 5, "Ghi tỷ lệ nhận đúng theo từng mức; không thay nguồn mic.", "Theo Acceptance", "P0", "Field");
add("H20 phần cứng", "Góc nói", "Nói ở 0/45/90/180 độ", h20Ready, "Giữ 1 m; thay góc nói", "4 angles", 5, "Đo suy giảm; không false accept do tiếng vọng.", "0°/45° đạt ≥90%", "P1", "Field");
add("H20 phần cứng", "Tiếng ồn", "Phòng 35–40/50–55/65–70 dBA", h20Ready, "Mỗi trẻ nói bộ câu ở ba mức ồn", "3 noise levels", 5, "Tỷ lệ theo ngưỡng; không tự kích hoạt bởi trẻ khác.", "Baseline ≥95%; lớp học ≥90%", "P0", "Field");
add("H20 phần cứng", "Echo", "Loa H20 phát xong rồi micro mở", h20Ready, "Chạy 100 prompt→beep→listen", "100 cycles", 100, "Không nhận lại câu Bi cô hoặc tiếng tít.", "0 self-recognition", "P0", "Acoustic echo");
add("H20 phần cứng", "Khoảng cách BT", "1/5/10 m và qua một tường", h20Ready, "Điều khiển MAIN và audio ở từng mức", "RF distance", 10, "Ghi packet loss/dropout; không treo khi yếu sóng.", "1–5 m ≥99%; 10 m quan sát", "P1", "RF field");
add("H20 phần cứng", "Pin yếu", "H20 ở 20%, 10% và gần cạn", h20Ready, "Chạy MAIN, ghi và phát audio", "Low battery", 10, "Trạng thái rõ; không packet loạn; mất nguồn được xử lý an toàn.", "0 crash/data corruption", "P1", "Endurance");
add("H20 phần cứng", "Nhiều H20", "Hai H20 cùng quảng bá gần điện thoại", "2 H20 bật", "Quét; chọn đúng ID; kết nối; chạy loopback", "2 devices at 1 m", 10, "Không tự nối nhầm; UI phân biệt thiết bị.", "10/10 đúng unit", "P0", "Multi-device");
add("H20 phần cứng", "Legacy", "Không dùng FF12/FF13/FF14 trên V1", h20Ready, "Thu log GATT khi chạy toàn bộ luồng", "V1 firmware", 1, "Không có request truyền audio BLE legacy.", "0 legacy audio packet", "P0", "Architecture");

// Phi chức năng, bảo mật và nghiệm thu.
add("Phi chức năng", "Hiệu năng", "Cold start và warm start", "5 điện thoại thật", "Đo 30 lần cold/warm", "API 24–36", 30, "Màn hình chính phản hồi; không block do preload.", "Cold P95 ≤3s; warm ≤1.5s", "P1", "Performance");
add("Phi chức năng", "Độ trễ", "Main→prompt→beep→mic ready", "Thiết bị thật + H20", "Quay video 60fps/ghi timestamp 30 vòng", "30 cycles/device", 30, "Các mốc đáp ứng ngưỡng Acceptance.", "Prompt≤1s; beep/mic≤300ms", "P0", "Performance");
add("Phi chức năng", "Độ trễ", "Speech end→text→audio result", "Mạng tốt và mạng yếu", "Đo 30 lượt mỗi mạng", "Wi-Fi/4G/weak", 30, "P95 không vượt ngưỡng; không treo.", "Text≤2.5s; audio≤5s", "P0", "Performance");
add("Phi chức năng", "Soak", "100 lượt nói liên tục", "Điện thoại + H20 đầy pin", "Chạy 100 lượt hỗn hợp Main/dịch/bài học", "2 giờ", 100, "Không crash, leak, nóng bất thường hoặc chồng phiên.", "0 crash; 0 overlap", "P0", "Stability");
add("Phi chức năng", "Accessibility", "Text scale 200% và màn 320×568", appReady, "Tăng font; đi qua luồng chính", "Large text/compact", 3, "Không mất nút chính; nội dung quan trọng đọc được.", "0 blocker", "P2", "Accessibility");
add("Phi chức năng", "Bảo mật", "APK không chứa secret backend", "APK release", "Scan strings/config; kiểm tra traffic HTTPS", "Static/dynamic", 1, "Không có API key; usesCleartextTraffic=false.", "0 secret; 100% HTTPS", "P0", "Security");
add("Phi chức năng", "Quyền riêng tư", "Giọng trẻ không lưu/đẩy ngoài mục đích", "Có consent test", "Đối chiếu luồng upload, history, delete", "Child voice data", 1, "Dữ liệu theo chính sách; xóa được; không ghi PII ngoài cần thiết.", "100% theo consent/retention", "P0", "Privacy");
add("Phi chức năng", "Ký ứng dụng", "Xác nhận release signing", "Có APK candidate", "Kiểm tra certificate và khả năng upgrade", "Release cert", 1, "Dùng production keystore trước phát hành; không ký debug.", "Production cert", "P0", "Release readiness");

// TEST CASE SHEET
title(tcSheet, "A1:H1", "INNOTRIK — TEST CASE APP + H20", "A2:H2", `Bộ test thực địa cho Android, trợ lý Bi cô, giọng trẻ em và H20 V1. Tổng ${tcs.length} test case.`);
const tcHeaders = ["TC_ID","Nhóm","Tính năng","Kịch bản","Điều kiện trước","Các bước","Dữ liệu/Môi trường","Số lần","Kết quả mong đợi","Chỉ số đạt","Priority","Loại test","Phụ trách","Status","Kết quả thực tế","Evidence","Bug ID","Ghi chú"];
tcSheet.getRange("A4:R4").values = [tcHeaders];
header(tcSheet.getRange("A4:R4"), C.blue);
const tcRows = tcs.map(x => [x.id,x.group,x.feature,x.scenario,x.pre,x.steps,x.data,x.repeats,x.expected,x.metric,x.priority,x.type,x.owner,"Not Run","","","",""]);
tcSheet.getRange(`A5:R${4 + tcRows.length}`).values = tcRows;
body(tcSheet.getRange(`A5:R${4 + tcRows.length}`));
tcSheet.getRange(`A5:R${4 + tcRows.length}`).format.rowHeight = 58;
const widths = [11,24,18,34,36,42,30,10,38,24,10,17,13,12,28,20,14,24];
widths.forEach((w,i)=>tcSheet.getRangeByIndexes(0,i,4+tcRows.length,1).format.columnWidth=w);
tcSheet.getRange(`H5:H${4 + tcRows.length}`).format.numberFormat = "0";
tcSheet.getRange(`N5:N${4 + tcRows.length}`).dataValidation = { rule: { type: "list", values: ["Not Run","Passed","Failed","Blocked","N/A"] } };
tcSheet.getRange(`K5:K${4 + tcRows.length}`).dataValidation = { rule: { type: "list", values: ["P0","P1","P2","P3"] } };
tcSheet.getRange(`N5:N${4 + tcRows.length}`).conditionalFormats.add("containsText", { text: "Passed", format: { fill: C.green, font: { color: C.greenText, bold: true } } });
tcSheet.getRange(`N5:N${4 + tcRows.length}`).conditionalFormats.add("containsText", { text: "Failed", format: { fill: C.red, font: { color: C.redText, bold: true } } });
tcSheet.getRange(`N5:N${4 + tcRows.length}`).conditionalFormats.add("containsText", { text: "Blocked", format: { fill: C.amber, font: { color: C.amberText, bold: true } } });
const tcTable = tcSheet.tables.add(`A4:R${4 + tcRows.length}`, true, "H20TestCases");
tcTable.style = "TableStyleMedium2";
tcTable.showFilterButton = true;
tcSheet.freezePanes.freezeRows(4);
tcSheet.freezePanes.freezeColumns(1);

// VOICE MATRIX
title(voiceSheet, "A1:H1", "VOICE FIELD MATRIX", "A2:H2", "Ma trận cân bằng điều kiện; không chạy full-factorial để tránh gây mệt cho trẻ.");
const vmHeaders=["Matrix ID","Nhóm tuổi","Điều kiện","Khoảng cách (m)","Góc","Noise dBA","Tốc độ","Âm lượng","Mạng","Số trẻ","Câu/trẻ","Lặp/câu","Số buổi","Tổng lượt nói"];
voiceSheet.getRange("A4:N4").values=[vmHeaders]; header(voiceSheet.getRange("A4:N4"));
const vm=[
 ["VM-01","3–5","Baseline",0.5,"0°","35–40","Tự nhiên","Bình thường","Wi-Fi tốt",10,10,2,2],
 ["VM-02","6–7","Baseline",0.5,"0°","35–40","Tự nhiên","Bình thường","Wi-Fi tốt",10,10,2,2],
 ["VM-03","8–10","Baseline",0.5,"0°","35–40","Tự nhiên","Bình thường","Wi-Fi tốt",10,10,2,2],
 ["VM-04","11–12","Baseline",0.5,"0°","35–40","Tự nhiên","Bình thường","Wi-Fi tốt",10,10,2,2],
 ["VM-05","13–15","Baseline",0.5,"0°","35–40","Tự nhiên","Bình thường","Wi-Fi tốt",10,10,2,2],
 ["VM-06","Tất cả","Gần",0.3,"0°","35–40","Bình thường","Nhỏ","Wi-Fi tốt",10,4,1,1],
 ["VM-07","Tất cả","Khoảng cách chuẩn",1,"0°","50–55","Bình thường","Bình thường","Wi-Fi tốt",15,4,2,1],
 ["VM-08","Tất cả","Xa",2,"0°","50–55","Bình thường","Bình thường","Wi-Fi tốt",15,4,2,1],
 ["VM-09","Tất cả","Stress khoảng cách",3,"0°","35–40","Bình thường","Bình thường","Wi-Fi tốt",10,4,1,1],
 ["VM-10","Tất cả","Nói chậm",0.5,"0°","35–40","60–80 wpm","Bình thường","Wi-Fi tốt",15,4,2,1],
 ["VM-11","Tất cả","Nói nhanh",0.5,"0°","35–40","130–160 wpm","Bình thường","Wi-Fi tốt",15,4,2,1],
 ["VM-12","Tất cả","Nói ngắt quãng",0.5,"0°","35–40","Dừng 0,5–1s","Bình thường","Wi-Fi tốt",10,4,1,1],
 ["VM-13","Tất cả","Lớp học ồn",0.5,"0°","65–70","Bình thường","Bình thường","Wi-Fi tốt",15,4,2,1],
 ["VM-14","Tất cả","Góc 45°",1,"45°","50–55","Bình thường","Bình thường","Wi-Fi tốt",10,4,1,1],
 ["VM-15","Tất cả","Góc 90°",1,"90°","50–55","Bình thường","Bình thường","Wi-Fi tốt",10,4,1,1],
 ["VM-16","Tất cả","Góc 180°",1,"180°","50–55","Bình thường","Bình thường","Wi-Fi tốt",10,4,1,1],
 ["VM-17","Tất cả","Mạng 4G",0.5,"0°","35–40","Bình thường","Bình thường","4G",10,4,1,1],
 ["VM-18","Tất cả","Mạng yếu",0.5,"0°","35–40","Bình thường","Bình thường","500–1000ms/5% loss",10,4,1,1],
 ["VM-19","Tất cả","Echo H20",0.5,"0°","50–55","Bình thường","Bình thường","Wi-Fi tốt",15,4,1,1],
 ["VM-20","Tất cả","Bluetooth qua tường",1,"0°","50–55","Bình thường","Bình thường","Wi-Fi tốt",10,2,1,1],
];
voiceSheet.getRange(`A5:M${4+vm.length}`).values=vm;
voiceSheet.getRange("N5").formulas=[["=J5*K5*L5*M5"]];
voiceSheet.getRange(`N5:N${4+vm.length}`).fillDown();
body(voiceSheet.getRange(`A5:N${4+vm.length}`));
voiceSheet.getRange(`A5:N${4+vm.length}`).format.rowHeight=34;
[12,13,24,14,10,12,18,15,22,10,10,10,10,15].forEach((w,i)=>voiceSheet.getRangeByIndexes(0,i,4+vm.length,1).format.columnWidth=w);
voiceSheet.getRange(`D5:D${4+vm.length}`).format.numberFormat="0.0";
voiceSheet.getRange(`J5:N${4+vm.length}`).format.numberFormat="#,##0";
voiceSheet.tables.add(`A4:N${4+vm.length}`,true,"VoiceFieldMatrix").style="TableStyleMedium2";
voiceSheet.freezePanes.freezeRows(4);

// CHILD PLAN
title(childSheet,"A1:H1","CHILD PARTICIPANT PLAN","A2:H2","Khuyến nghị 50 trẻ; pilot tối thiểu 30 trẻ. Mỗi trẻ tham gia 2 buổi để kiểm tra khả năng lặp lại.");
const cpHeaders=["Nhóm tuổi","Pilot tối thiểu","Khuyến nghị","Số buổi/trẻ","Câu/buổi","Tổng pilot","Tổng khuyến nghị","Yêu cầu mẫu"];
childSheet.getRange("A4:H4").values=[cpHeaders]; header(childSheet.getRange("A4:H4"));
const ages=[["3–5",6,10,2,30],["6–7",6,10,2,30],["8–10",6,10,2,30],["11–12",6,10,2,30],["13–15",6,10,2,30]];
childSheet.getRange("A5:E9").values=ages;
childSheet.getRange("F5:G5").formulas=[["=B5*D5*E5","=C5*D5*E5"]]; childSheet.getRange("F5:G9").fillDown();
childSheet.getRange("H5:H9").values=Array.from({length:5},()=>["Giọng Bắc/Trung/Nam; cân bằng nam/nữ; có đồng ý phụ huynh; không ghi tên thật cùng audio."]);
childSheet.getRange("A10:E10").values=[["TỔNG",null,null,null,null]];
childSheet.getRange("B10:C10").formulas=[["=SUM(B5:B9)","=SUM(C5:C9)"]];
childSheet.getRange("F10:G10").formulas=[["=SUM(F5:F9)","=SUM(G5:G9)"]];
body(childSheet.getRange("A5:H10")); childSheet.getRange("A10:H10").format={fill:C.cyan,font:{bold:true,color:C.navy}};
[14,14,14,14,14,16,20,54].forEach((w,i)=>childSheet.getRangeByIndexes(0,i,10,1).format.columnWidth=w);
childSheet.getRange("A5:H9").format.rowHeight=42; childSheet.freezePanes.freezeRows(4);

// DEVICE MATRIX
title(deviceSheet,"A1:H1","DEVICE & H20 MATRIX","A2:H2","Điện thoại thật là bắt buộc cho BLE/HFP. Emulator chỉ dùng cho UI và logic, không dùng nghiệm thu H20.");
const dmHeaders=["ID","Loại","Hệ điều hành/Firmware","Mẫu đề xuất","Mục tiêu","Số lượng","Trạng thái","Ghi chú"];
deviceSheet.getRange("A4:H4").values=[dmHeaders]; header(deviceSheet.getRange("A4:H4"));
const devices=[
 ["DEV-01","Android phone","Android 7 / API 24","Máy cấu hình thấp","minSdk, permission cũ",1,"Planned","Thiết bị thật"],
 ["DEV-02","Android phone","Android 10/11","Samsung","HFP/BLE trước Android 12",1,"Planned","Thiết bị thật"],
 ["DEV-03","Android phone","Android 12/13","Xiaomi/Oppo","Nearby devices permission",1,"Planned","Thiết bị thật"],
 ["DEV-04","Android phone","Android 14","Pixel/Samsung","Audio route và quyền mới",1,"Planned","Thiết bị thật"],
 ["DEV-05","Android phone","Android 16 / API 36","Pixel/Emulator","Latest OS; emulator không nghiệm thu H20",1,"Available: emulator","Hiện chỉ có emulator-5554"],
 ["H20-01","H20 V1","Ghi khi nhận mẫu","Unit 1","Baseline",1,"Required","Khác ID"],
 ["H20-02","H20 V1","Ghi khi nhận mẫu","Unit 2","Reconnect/so sánh",1,"Required","Khác ID"],
 ["H20-03","H20 V1","Ghi khi nhận mẫu","Unit 3","Độ ổn định lô",1,"Recommended",""],
 ["H20-04","H20 V1","Ghi khi nhận mẫu","Unit 4","Độ ổn định lô",1,"Recommended",""],
 ["H20-05","H20 V1","Ghi khi nhận mẫu","Unit 5","Độ ổn định lô",1,"Recommended",""],
];
deviceSheet.getRange(`A5:H${4+devices.length}`).values=devices; body(deviceSheet.getRange(`A5:H${4+devices.length}`));
deviceSheet.getRange(`A5:H${4+devices.length}`).format.rowHeight=36;
[12,18,25,22,28,10,22,34].forEach((w,i)=>deviceSheet.getRangeByIndexes(0,i,4+devices.length,1).format.columnWidth=w);
deviceSheet.getRange(`G5:G${4+devices.length}`).dataValidation={rule:{type:"list",values:["Planned","Available","Available: emulator","In Test","Blocked","Retired","Required","Recommended"]}};
deviceSheet.tables.add(`A4:H${4+devices.length}`,true,"DeviceMatrix").style="TableStyleMedium2";
deviceSheet.freezePanes.freezeRows(4);

// EXECUTION LOG
title(executionSheet,"A1:H1","FIELD EXECUTION LOG","A2:H2","Mỗi dòng là một lần chạy. Không ghi tên thật của trẻ; chỉ dùng Participant ID đã được đồng ý.");
const exHeaders=["Run ID","Ngày","TC_ID","Matrix ID","Device ID","H20 ID","Participant ID","Tuổi","Khoảng cách","Noise dBA","Tốc độ","Câu đã nói","Transcript","Kết quả","Latency ms","Evidence","Bug ID","Tester"];
executionSheet.getRange("A4:R4").values=[exHeaders]; header(executionSheet.getRange("A4:R4"),C.blue);
const exRows=Array.from({length:100},(_,i)=>[`RUN-${String(i+1).padStart(4,"0")}`,null,"","","","","",null,null,null,"","","","Not Run",null,"","",""]);
executionSheet.getRange("A5:R104").values=exRows; body(executionSheet.getRange("A5:R104"));
executionSheet.getRange("A5:R104").format.rowHeight=30;
executionSheet.getRange("B5:B104").format.numberFormat="yyyy-mm-dd";
executionSheet.getRange("H5:J104").format.numberFormat="0"; executionSheet.getRange("O5:O104").format.numberFormat="#,##0";
executionSheet.getRange("N5:N104").dataValidation={rule:{type:"list",values:["Not Run","Passed","Failed","Blocked","N/A"]}};
executionSheet.getRange("N5:N104").conditionalFormats.add("containsText",{text:"Passed",format:{fill:C.green,font:{color:C.greenText,bold:true}}});
executionSheet.getRange("N5:N104").conditionalFormats.add("containsText",{text:"Failed",format:{fill:C.red,font:{color:C.redText,bold:true}}});
[13,13,11,12,13,12,16,8,13,11,15,32,30,12,13,20,13,16].forEach((w,i)=>executionSheet.getRangeByIndexes(0,i,104,1).format.columnWidth=w);
executionSheet.tables.add("A4:R104",true,"FieldExecutionLog").style="TableStyleMedium2";
executionSheet.freezePanes.freezeRows(4); executionSheet.freezePanes.freezeColumns(2);

// ACCEPTANCE
title(criteriaSheet,"A1:H1","ACCEPTANCE CRITERIA","A2:H2","Ngưỡng đề xuất cho RC; Product Owner và ODM cần ký xác nhận trước nghiệm thu chính thức.");
const acHeaders=["AC_ID","Nhóm","Chỉ số","Mục tiêu","Cách đo","Mẫu tối thiểu","Mức chặn","Ghi chú"];
criteriaSheet.getRange("A4:H4").values=[acHeaders]; header(criteriaSheet.getRange("A4:H4"));
const ac=[
 ["AC-01","MAIN","Tỷ lệ short press thành công","≥99%","Log sequence/event/action",100,"Release blocker","Không action đôi"],
 ["AC-02","Audio concurrency","TTS–micro chồng chéo","0 lỗi","Video/log state",100,"Release blocker","Không tự nghe tiếng Bi cô"],
 ["AC-03","ASR baseline","0,5–1 m; 35–40 dBA","≥95%","Intent/meaning correct",500,"Release blocker","Theo 5 nhóm tuổi"],
 ["AC-04","ASR lớp học","65–70 dBA","≥90%","Intent/meaning correct",200,"High","Không false activation"],
 ["AC-05","ASR tốc độ","Chậm và nhanh","≥90%","Intent/meaning correct",200,"High","Không cắt đầu/cuối"],
 ["AC-06","ASR khoảng cách","2 m","≥85%","Intent/meaning correct",120,"Medium","3 m là stress/quan sát"],
 ["AC-07","Reconnect","BLE/HFP reconnect ≤10s","≥95%","30 vòng/H20",30,"Release blocker","Subscribe Indicate lại"],
 ["AC-08","Beep timing","Prompt end → beep","≤300 ms P95","Video 60fps/timestamp",30,"High",""],
 ["AC-09","Mic ready","Beep → mic ready","≤300 ms P95","Log/UI timestamp",30,"Release blocker",""],
 ["AC-10","Text latency","Speech end → transcript","≤2.5 s P95","Telemetry",30,"High","Mạng tốt"],
 ["AC-11","Audio latency","Speech end → result audio","≤5 s P95","Telemetry",30,"High","Mạng tốt"],
 ["AC-12","Stability","Soak 2 giờ/100 lượt","0 crash; 0 overlap","Logcat + quan sát",100,"Release blocker",""],
 ["AC-13","Offline H20","Loopback không gọi cloud","100%","Network log",10,"Release blocker",""],
 ["AC-14","Route","Mic/loa H20 được xác nhận","100%","Android audio route + nghe thực tế",10,"Release blocker","Không fallback ẩn"],
 ["AC-15","Security","Secret trong APK/cleartext","0 secret; 100% HTTPS","Static/dynamic scan",1,"Release blocker",""],
 ["AC-16","Privacy","Consent/retention/delete","100% tuân thủ","Audit",1,"Release blocker","Dữ liệu trẻ em"],
];
criteriaSheet.getRange(`A5:H${4+ac.length}`).values=ac; body(criteriaSheet.getRange(`A5:H${4+ac.length}`)); criteriaSheet.getRange(`A5:H${4+ac.length}`).format.rowHeight=42;
[11,19,29,20,28,14,20,34].forEach((w,i)=>criteriaSheet.getRangeByIndexes(0,i,4+ac.length,1).format.columnWidth=w);
criteriaSheet.tables.add(`A4:H${4+ac.length}`,true,"AcceptanceCriteria").style="TableStyleMedium2"; criteriaSheet.freezePanes.freezeRows(4);

// INITIAL FINDINGS
title(findingSheet,"A1:H1","INITIAL FINDINGS — 2026-08-17","A2:H2","Kết quả kiểm tra Android Studio, cấu hình Flutter và automated test trước khi test H20 thật.");
const fiHeaders=["ID","Mức độ","Phát hiện","Bằng chứng","Ảnh hưởng","Hành động trước nghiệm thu","Owner","Status"];
findingSheet.getRange("A4:H4").values=[fiHeaders]; header(findingSheet.getRange("A4:H4"));
const findings=[
 ["F-01","Blocker","Chưa có điện thoại Android thật hoặc H20 kết nối","flutter devices chỉ thấy emulator-5554 Android 16/API 36","Không thể xác nhận BLE/HFP/mic/loa/MAIN vật lý","Kết nối ít nhất 4 điện thoại thật và 2 H20 pilot","QA/HW","Open"],
 ["F-02","High","Automated test chưa xanh","flutter test: 344 Passed, 3 Failed","Không nên dùng build làm baseline nghiệm thu","Sửa/review 3 test fail rồi chạy regression","Flutter","Open"],
 ["F-03","Medium","Golden popup nhắc học lệch 0,24%","797 pixels khác reference","Có thể là thay đổi UI chưa được duyệt","So sánh diff và duyệt/sửa UI","UI/QA","Open"],
 ["F-04","Medium","Golden pháo hoa chúc mừng lệch 0,24%","797 pixels khác reference","Ảnh hưởng giao diện bài học","So sánh diff và duyệt/sửa UI","UI/QA","Open"],
 ["F-05","High","Test Main mở menu rồi vào speaking trả false","Expected true, Actual false","Rủi ro Main không bắt đầu đúng luồng","Phân tích voice_navigation_controller_test.dart","Flutter","Open"],
 ["F-06","Blocker","AIV0_DRAFT_PROTOCOL_CONFIRMED mặc định false","AppConfig mặc định false","MAIN H20 chỉ Raw Hex nếu build thiếu dart-define","Build RC đã xác nhận với flag true","Release","Open"],
 ["F-07","Blocker","Release có thể ký debug nếu thiếu key.properties","build.gradle.kts fallback debug signing","Không phù hợp Play Store/upgrade production","Cung cấp production keystore","Release","Open"],
 ["F-08","Info","H20 V1 dùng HFP/SCO cho audio và BLE cho control","9E3B0001/2/3; Battery 180F; Firmware 180A","Test phải tách audio route và control route","Dùng ma trận H20 trong workbook","QA/HW","Accepted"],
 ["F-09","Info","Catalog có 5 nhóm, 50 chủ đề, 101 bài, 11 bài hát","JSON + automated test","Cần sampling và data integrity toàn catalog","Chạy data integrity + mẫu mỗi nhóm","Content QA","Planned"],
];
findingSheet.getRange(`A5:H${4+findings.length}`).values=findings; body(findingSheet.getRange(`A5:H${4+findings.length}`)); findingSheet.getRange(`A5:H${4+findings.length}`).format.rowHeight=58;
[10,12,34,34,32,38,16,14].forEach((w,i)=>findingSheet.getRangeByIndexes(0,i,4+findings.length,1).format.columnWidth=w);
findingSheet.getRange(`B5:B${4+findings.length}`).conditionalFormats.add("containsText",{text:"Blocker",format:{fill:C.red,font:{color:C.redText,bold:true}}});
findingSheet.getRange(`B5:B${4+findings.length}`).conditionalFormats.add("containsText",{text:"High",format:{fill:C.amber,font:{color:C.amberText,bold:true}}});
findingSheet.getRange(`H5:H${4+findings.length}`).dataValidation={rule:{type:"list",values:["Open","In Progress","Fixed","Accepted","Planned","Closed"]}};
findingSheet.tables.add(`A4:H${4+findings.length}`,true,"InitialFindings").style="TableStyleMedium2"; findingSheet.freezePanes.freezeRows(4);

// DASHBOARD
title(dashboard,"A1:Q2","INNOTRIK — APP + H20 QA DASHBOARD","A3:Q3","Cập nhật Status trong Test Cases và Execution Log; chỉ số sẽ tự động tính lại.");
dashboard.getRange("A5:H5").values=[["Tổng test case",null,"P0",null,"P1",null,"Tổng lượt nói kế hoạch",null]];
dashboard.getRange("A6:H6").formulas=[["=COUNTA('Test Cases'!$A$5:$A$250)",null,"=COUNTIF('Test Cases'!$K$5:$K$250,\"P0\")",null,"=COUNTIF('Test Cases'!$K$5:$K$250,\"P1\")",null,"=SUM('Voice Matrix'!$N$5:$N$40)",null]];
dashboard.getRange("A5:H6").format={fill:C.pale,borders:{preset:"outside",style:"thin",color:C.line}};
dashboard.getRange("A5:H5").format.font={bold:true,color:C.navy}; dashboard.getRange("A6:H6").format.font={bold:true,color:C.blue,size:18};
dashboard.getRange("A8:B8").values=[["Status","Số lượng"]]; header(dashboard.getRange("A8:B8"),C.blue);
dashboard.getRange("A9:A13").values=[["Not Run"],["Passed"],["Failed"],["Blocked"],["N/A"]];
dashboard.getRange("B9").formulas=[["=COUNTIF('Test Cases'!$N$5:$N$250,A9)"]]; dashboard.getRange("B9:B13").fillDown();
dashboard.getRange("A15:B17").values=[["Đã thực thi",null],["Tỷ lệ thực thi",null],["Tỷ lệ đạt",null]];
dashboard.getRange("B15:B17").formulas=[["=SUM(B10:B13)"],["=IF(A6=0,0,B15/A6)"],["=IF(B15=0,0,B10/B15)"]]; dashboard.getRange("B16:B17").format.numberFormat="0.0%";
dashboard.getRange("D8:E8").values=[["Nhóm test","Số test"]]; header(dashboard.getRange("D8:E8"),C.teal);
const groups=[...new Set(tcs.map(x=>x.group))]; dashboard.getRange(`D9:D${8+groups.length}`).values=groups.map(g=>[g]);
dashboard.getRange("E9").formulas=[["=COUNTIF('Test Cases'!$B$5:$B$250,D9)"]]; dashboard.getRange(`E9:E${8+groups.length}`).fillDown();
dashboard.getRange("G8:H8").values=[["Kiểm tra sẵn sàng","Giá trị"]]; header(dashboard.getRange("G8:H8"),C.teal);
dashboard.getRange("G9:G14").values=[["Trẻ pilot"],["Trẻ khuyến nghị"],["Phone thật yêu cầu"],["H20 nghiệm thu"],["Automated Passed"],["Automated Failed"]];
dashboard.getRange("H9:H14").formulas=[["='Child Plan'!B10"],["='Child Plan'!C10"],["=COUNTIF('Device Matrix'!$B$5:$B$20,\"Android phone\")-1"],["=COUNTIF('Device Matrix'!$B$5:$B$20,\"H20 V1\")"],["=344"],["=3"]];
body(dashboard.getRange("A9:H17")); dashboard.getRange("A9:H17").format.rowHeight=24;
[18,14,3,27,14,3,25,16,3,12,12,12,12,12,12,12,12].forEach((w,i)=>dashboard.getRangeByIndexes(0,i,38,1).format.columnWidth=w);
const statusChart=dashboard.charts.add("doughnut",dashboard.getRange("A8:B13")); statusChart.title="Tiến độ test case"; statusChart.hasLegend=true; statusChart.setPosition("J5","Q18");
const moduleChart=dashboard.charts.add("bar",dashboard.getRange(`D8:E${8+groups.length}`)); moduleChart.title="Số test theo nhóm"; moduleChart.hasLegend=false; moduleChart.setPosition("J20","Q38");
dashboard.freezePanes.freezeRows(3);

// Compact inspection and visual verification assets.
const inspectDashboard=await wb.inspect({kind:"table",range:"Dashboard!A1:H17",include:"values,formulas",tableMaxRows:20,tableMaxCols:8,maxChars:16000});
const inspectTC=await wb.inspect({kind:"table",range:"Test Cases!A1:R10",include:"values,formulas",tableMaxRows:10,tableMaxCols:18,maxChars:16000});
const errors=await wb.inspect({kind:"match",searchTerm:"#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",options:{useRegex:true,maxResults:300},summary:"final formula error scan"});
await fs.writeFile(path.join(previewDir,"verification.ndjson"),[inspectDashboard.ndjson,inspectTC.ndjson,errors.ndjson].join("\n"),"utf8");

const previews=[
 ["Dashboard","A1:Q38","dashboard.png"],
 ["Test Cases",`A1:J14`,"test-cases.png"],
 ["Voice Matrix","A1:N24","voice-matrix.png"],
 ["Child Plan","A1:H10","child-plan.png"],
 ["Device Matrix","A1:H14","device-matrix.png"],
 ["Execution Log","A1:R12","execution-log.png"],
 ["Acceptance","A1:H20","acceptance.png"],
 ["Initial Findings","A1:H13","findings.png"],
];
for (const [sheetName,range,fileName] of previews) {
  const blob=await wb.render({sheetName,range,scale:1,format:"png"});
  await fs.writeFile(path.join(previewDir,fileName),new Uint8Array(await blob.arrayBuffer()));
}

const outputPath=path.join(outputDir,"INNOTRIK_App_H20_Field_Test_Plan_v1.0.xlsx");
const xlsx=await SpreadsheetFile.exportXlsx(wb);
await xlsx.save(outputPath);
console.log(JSON.stringify({outputPath,testCaseCount:tcs.length,groups:groups.length,plannedVoiceRuns:vm.reduce((s,r)=>s+r[9]*r[10]*r[11]*r[12],0),sheets:8},null,2));
