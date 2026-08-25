import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("Missing output directory");

const workbook = Workbook.create();
const dashboard = workbook.worksheets.add("Dashboard");
const testSheet = workbook.worksheets.add("Test Cases");
const dataSheet = workbook.worksheets.add("Test Data");
const traceSheet = workbook.worksheets.add("Traceability");
const defectSheet = workbook.worksheets.add("Defect Log");
const guideSheet = workbook.worksheets.add("Huong dan");

const steps = (...items) => items.map((item, index) => `${index + 1}. ${item}`).join("\n");
const cases = [];
const add = (
  module,
  feature,
  scenario,
  precondition,
  actionSteps,
  testData,
  expected,
  priority = "P1",
  type = "Functional",
  platform = "Android",
) => {
  cases.push({
    id: `TC-${String(cases.length + 1).padStart(3, "0")}`,
    module,
    feature,
    scenario,
    precondition,
    steps: actionSteps,
    testData,
    expected,
    priority,
    type,
    platform,
  });
};

const apk = "APK production 1.0.4+8 đã cài; thiết bị Android API 24+";
const online = `${apk}; mạng ổn định; đã cấp quyền micro`;
const atHome = `${online}; ứng dụng đang ở trang chủ và không có audio khác đang phát`;
const inLesson = `${online}; đang ở một câu trong bài học chủ đề`;

// 1. Installation and lifecycle.
add("Cài đặt & vòng đời", "Cài đặt", "Cài mới APK production", "Thiết bị chưa cài ứng dụng", steps("Cài APK build 8", "Mở ứng dụng"), "APK build 8", "Cài đặt thành công; ứng dụng mở được; không crash; versionCode là 8.", "P0", "Compatibility");
add("Cài đặt & vòng đời", "Nâng cấp", "Nâng cấp từ build 7 lên build 8", "Đã cài build 7 và có tiến độ học/từ vựng", steps("Cài đè build 8", "Mở ứng dụng", "Kiểm tra tiến độ và từ vựng"), "Build 7 → build 8", "Nâng cấp thành công; dữ liệu học, Ngôi sao và Luyện lại không bị mất.", "P0", "Regression");
add("Cài đặt & vòng đời", "Khởi động", "Mở ứng dụng lần đầu và cấp quyền micro", "Cài mới ứng dụng", steps("Mở ứng dụng", "Chọn Cho phép khi hệ thống hỏi quyền micro", "Nhấn Main"), "Quyền micro: Allow", "Ứng dụng vào trang chủ; Main sử dụng được; không hỏi quyền lặp vô hạn.", "P0");
add("Cài đặt & vòng đời", "Quyền micro", "Từ chối quyền micro", "Cài mới ứng dụng", steps("Mở ứng dụng", "Chọn Không cho phép", "Thử dùng Main"), "Quyền micro: Deny", "Ứng dụng không crash; hiển thị hướng dẫn cấp quyền rõ ràng; không bắt đầu ghi âm giả.", "P0", "Negative");
add("Cài đặt & vòng đời", "Quyền micro", "Thu hồi quyền micro khi ứng dụng đã cài", apk, steps("Thu hồi quyền micro trong Settings", "Quay lại ứng dụng", "Nhấn Main"), "Permission revoked", "Luồng ghi âm bị chặn an toàn và có thông báo thân thiện; không treo trạng thái đang nghe.", "P1", "Recovery");
add("Cài đặt & vòng đời", "Khởi động", "Mở ứng dụng khi mất mạng", `${apk}; tắt Wi-Fi và dữ liệu di động`, steps("Mở ứng dụng", "Đi qua các trang chính"), "Offline", "Ứng dụng vẫn mở được; nội dung cục bộ hiển thị; tính năng cần mạng báo lỗi thân thiện.", "P1", "Negative");
add("Cài đặt & vòng đời", "Lifecycle", "Tắt màn hình rồi mở lại khi ứng dụng còn chạy", `${online}; ứng dụng đang ở foreground`, steps("Tắt màn hình 15 giây", "Mở khóa", "Quay lại ứng dụng", "Nhấn Main"), "Screen off/on", "Không có phiên micro ma; trạng thái Main khôi phục đúng; người dùng có thể bắt đầu lượt mới.", "P1", "Recovery");

// 2. Main button and wake word.
add("Main & Wake word", "Hiển thị Main", "Main cố định trên toàn ứng dụng", online, steps("Mở lần lượt Trang chủ, Từ vựng, Chủ đề, danh sách bài và bài học", "Quan sát Main"), "Các màn chính", "Main luôn hiển thị đúng vị trí, không che nút quan trọng và có thể thao tác.", "P1", "Usability");
add("Main & Wake word", "Main menu", "Nhấn Main tại trang chủ", atHome, steps("Nhấn Main một lần", "Nghe toàn bộ phản hồi"), "Tap Main", "Bi cô nói đúng menu chức năng; sau khi nói xong phát tiếng tít rồi mới mở micro.", "P0");
add("Main & Wake word", "TTS/Beep/ASR", "Không nghe người dùng trong lúc Bi cô đang nói", atHome, steps("Nhấn Main", "Nói chen khi Bi cô chưa nói xong", "Nói lại sau tiếng tít"), "Nói chen trước beep", "Câu nói chen không bị xử lý; chỉ câu sau tiếng tít được nhận diện.", "P0", "Integration");
add("Main & Wake word", "Chống chồng chéo", "Nhấn Main nhanh hai lần", atHome, steps("Nhấn Main hai lần trong 300 ms", "Quan sát audio và micro"), "Double tap", "Chỉ có một phiên trợ lý; không phát hai câu đồng thời; không mở hai micro.", "P0", "Negative");
add("Main & Wake word", "Fallback", "Nói yêu cầu không thuộc menu", atHome, steps("Nhấn Main", "Sau tiếng tít nói câu không liên quan"), "Con muốn ăn cơm", "Không điều hướng sai; Bi cô hỏi lại hoặc đưa hướng dẫn lựa chọn hợp lệ.", "P1", "Negative");
add("Main & Wake word", "Timeout", "Không nói trong cửa sổ lệnh đầu tiên", atHome, steps("Nhấn Main", "Im lặng sau tiếng tít"), "Im lặng ≥ 6 giây", "Bi cô hỏi lại “Con muốn làm gì?” và mở một cửa sổ nghe mới.", "P1", "Negative");
add("Main & Wake word", "Timeout", "Tiếp tục im lặng sau lần hỏi lại", atHome, steps("Nhấn Main", "Im lặng ở cả hai cửa sổ nghe"), "Im lặng hai lần", "Phiên Main kết thúc; nút trở về trạng thái ban đầu; micro được giải phóng.", "P1", "Recovery");
add("Main & Wake word", "Wake word", "Kích hoạt bằng Hey Pico khi ứng dụng đang mở", atHome, steps("Nói Hey Pico", "Chờ phản hồi và tiếng tít", "Nói tên chức năng"), "Hey Pico", "Ứng dụng phản hồi một lần và nhận lệnh sau tiếng tít.", "P1");
add("Main & Wake word", "Wake word", "Nhận diện biến thể ASR của Hey Pico", atHome, steps("Lần lượt nói các biến thể", "Theo dõi trạng thái trợ lý"), "Hey Piko; Hey Bi cô; Pico", "Các biến thể được hỗ trợ kích hoạt đúng; từ không liên quan không kích hoạt.", "P2", "Regression");
add("Main & Wake word", "Echo guard", "Không nhận lại chính câu Bi cô vừa phát", atHome, steps("Nhấn Main", "Để loa ngoài hoạt động bình thường", "Không nói gì"), "Prompt phát qua loa", "Prompt không bị ASR coi là lệnh của trẻ; không tự điều hướng.", "P0", "Integration");
add("Main & Wake word", "Audio focus", "Nhấn Main khi audio bài học đang phát", `${online}; audio mẫu đang phát`, steps("Nhấn Main", "Quan sát audio, TTS và micro"), "Audio lesson active", "Audio bài học dừng/giảm đúng thiết kế; chỉ một nguồn phát; trợ lý nghe sau beep.", "P0", "Integration");
add("Main & Wake word", "Nhấn giữ", "Nhấn giữ Main lần 1 trong bài học", inLesson, steps("Nhấn giữ Main", "Quan sát ghi âm và audio"), "Long press #1", "Bài học và ghi âm dừng; ứng dụng nói “Đã dừng”; không gửi bản ghi dở lên backend.", "P0", "Regression");
add("Main & Wake word", "Nhấn giữ", "Nhấn giữ Main lần 2 để tiếp tục", `${inLesson}; bài đang ở trạng thái dừng bởi Main`, steps("Nhấn giữ Main lần nữa", "Chờ phản hồi", "Quan sát micro"), "Long press #2", "Ứng dụng nói “Cùng học tiếp nhé” và tự động mở một lượt ghi âm mới.", "P0", "Regression");

// 3. AI navigation.
add("Điều hướng AI", "Menu chính", "Chọn Luyện nói", atHome, steps("Nhấn Main", "Nói Con muốn luyện nói"), "Con muốn luyện nói", "Mở đúng luồng Luyện nói; Bi cô nói “Bắt đầu nói đi con”.", "P0");
add("Điều hướng AI", "Menu chính", "Chọn Học chủ đề", atHome, steps("Nhấn Main", "Nói Con muốn học theo chủ đề"), "Con muốn học theo chủ đề", "Bi cô hỏi tuổi và tiếp tục nghe sau tiếng tít.", "P0");
add("Điều hướng AI", "Menu chính", "Chọn Từ vựng", atHome, steps("Nhấn Main", "Nói Con muốn học từ vựng"), "Con muốn học từ vựng", "Điều hướng đúng trang Từ vựng; không mở Luyện nói hoặc Chủ đề.", "P1");
add("Điều hướng AI", "Menu chính", "Chọn Dịch tiếng Anh", atHome, steps("Nhấn Main", "Nói Con muốn dịch sang tiếng Anh"), "Con muốn dịch sang tiếng Anh", "Bi cô hỏi chọn Dịch một câu hay Dịch liên tục.", "P0");
add("Điều hướng AI", "Nhận diện ý định", "Câu lệnh không dấu", atHome, steps("Nhấn Main", "Nói câu không dấu qua nguồn ASR giả lập"), "con muon hoc chu de", "Ý định được nhận diện giống câu có dấu.", "P1", "Regression");
add("Điều hướng AI", "Chọn tuổi", "Nói tuổi hợp lệ bằng chữ số", `${online}; Bi cô đang hỏi tuổi`, steps("Nói Con 4 tuổi"), "4", "Chọn nhóm tuổi 3–5 và đọc đúng số chủ đề của nhóm.", "P0");
add("Điều hướng AI", "Chọn tuổi", "Nói tuổi hợp lệ bằng chữ", `${online}; Bi cô đang hỏi tuổi`, steps("Nói Con sáu tuổi"), "sáu", "Chọn nhóm tuổi 6–7 và đọc đúng số chủ đề.", "P1");
add("Điều hướng AI", "Chọn tuổi", "Tuổi ngoài phạm vi hỗ trợ", `${online}; Bi cô đang hỏi tuổi`, steps("Nói Con 2 tuổi", "Nghe phản hồi"), "2 tuổi", "Không chọn sai nhóm; Bi cô yêu cầu tuổi trong phạm vi được hỗ trợ.", "P1", "Negative");
add("Điều hướng AI", "Chọn tuổi", "Câu không chứa tuổi", `${online}; Bi cô đang hỏi tuổi`, steps("Nói Con muốn học", "Nghe phản hồi"), "Không có số", "Không tự suy đoán tuổi; Bi cô yêu cầu nói lại với ví dụ rõ ràng.", "P1", "Negative");
add("Điều hướng AI", "Chọn chủ đề", "Số lượng chủ đề khớp nhóm tuổi", `${online}; đã chọn một tuổi hợp lệ`, steps("Nghe câu hỏi chọn chủ đề", "Đối chiếu danh sách UI"), "N = số chủ đề nhóm tuổi", "Số N Bi cô nói bằng đúng số chủ đề đang hiển thị.", "P0", "Integration");
add("Điều hướng AI", "Chọn chủ đề", "Chọn chủ đề hợp lệ bằng số", `${online}; đang chờ chọn chủ đề`, steps("Nói Con chọn chủ đề số 3"), "Chủ đề số 3", "Mở đúng chủ đề số 3 và đọc đúng số bài học.", "P0");
add("Điều hướng AI", "Chọn chủ đề", "Chọn số chủ đề vượt phạm vi", `${online}; đang chờ chọn chủ đề`, steps("Nói Chủ đề số 99"), "99", "Không điều hướng; Bi cô nêu phạm vi hợp lệ và tiếp tục nghe.", "P1", "Negative");
add("Điều hướng AI", "Chọn bài", "Số lượng bài khớp nội dung chủ đề", `${online}; đã chọn chủ đề`, steps("Nghe câu hỏi chọn bài", "Đối chiếu danh sách bài"), "M = số bài", "Số bài Bi cô nói khớp dữ liệu chủ đề.", "P0", "Integration");
add("Điều hướng AI", "Chọn bài", "Chọn bài hợp lệ", `${online}; đang chờ chọn bài`, steps("Nói Con học bài số 1"), "Bài số 1", "Bi cô nói “Bắt đầu học thôi con”; sau đó mở đúng bài số 1.", "P0");
add("Điều hướng AI", "Chọn bài", "Chọn bài vượt phạm vi", `${online}; đang chờ chọn bài`, steps("Nói Bài số 10 khi chủ đề có 2 bài"), "10", "Không mở bài sai; Bi cô nêu phạm vi bài hợp lệ.", "P1", "Negative");
add("Điều hướng AI", "Điều hướng trực tiếp", "Nói đồng thời chủ đề và bài", atHome, steps("Kích hoạt trợ lý", "Nói Học chủ đề số 3 bài số 1"), "Chủ đề 3, bài 1", "Mở đúng chủ đề và bài tương ứng hoặc dẫn dắt không mất ngữ cảnh.", "P1", "Integration");
add("Điều hướng AI", "Chống lặp", "Không tự chọn số từ câu hỏi của Bi cô", `${online}; loa ngoài; đang ở bước chọn chủ đề/bài`, steps("Không nói sau khi Bi cô hỏi", "Theo dõi điều hướng"), "Prompt chứa số N", "Các con số trong prompt không bị nhận là lựa chọn của trẻ.", "P0", "Regression");
add("Điều hướng AI", "Khôi phục", "Mất mạng khi đang tải nội dung chủ đề", `${online}; đang ở bước chọn chủ đề`, steps("Tắt mạng", "Chọn chủ đề"), "Offline during load", "Không crash; Bi cô báo chưa tải được và kết thúc/cho thử lại rõ ràng.", "P1", "Recovery");

// 4. Speaking flow.
add("Luyện nói", "Bắt đầu", "Vào Luyện nói từ Main", atHome, steps("Nhấn Main", "Chọn Luyện nói"), "Con muốn luyện nói", "Bi cô nói “Bắt đầu nói đi con”; phát beep; chuẩn bị micro.", "P0");
add("Luyện nói", "Micro", "Micro tự mở cho câu đầu", `${online}; vừa vào Luyện nói`, steps("Chờ Bi cô và beep", "Quan sát trạng thái micro"), "Không nhấn thêm", "Micro tự mở đúng một lần; không cần nhấn nút Nói của tính năng cũ.", "P0", "Regression");
add("Luyện nói", "VAD", "Tự động dừng khi trẻ nói xong", `${online}; micro Luyện nói đang mở`, steps("Nói một câu", "Dừng nói"), "Con muốn uống nước", "Ứng dụng tự kết thúc ghi âm sau khoảng lặng; không cần nhấn Main để dừng câu.", "P0", "Integration");
add("Luyện nói", "Kết quả", "Hiển thị câu gốc và câu dịch", `${online}; đã ghi âm câu hợp lệ`, steps("Chờ xử lý hoàn tất", "Kiểm tra kết quả"), "Con muốn uống nước", "Hiển thị đúng câu tiếng Việt và bản dịch tiếng Anh; không đảo ngôn ngữ.", "P0");
add("Luyện nói", "Phát âm", "Phát audio câu kết quả", `${online}; dịch thành công`, steps("Nghe audio tự phát", "Bấm nghe lại nếu có"), "I want to drink water.", "Audio tiếng Anh phát rõ; nội dung khớp câu dịch; không phát chồng TTS khác.", "P1");
add("Luyện nói", "Lượt tiếp theo", "Tự tạo lượt nói mới sau audio", `${online}; audio kết quả vừa phát xong`, steps("Chờ beep", "Nói câu tiếp theo"), "Câu thứ hai", "Micro tự mở lại sau beep; câu thứ hai tạo kết quả riêng, không nối vào câu trước.", "P0", "Regression");
add("Luyện nói", "Timeout", "Im lặng 10 giây ở trạng thái sẵn sàng", `${online}; Luyện nói đang chờ câu mới`, steps("Không nói trong 10 giây"), "Silence 10s", "Ứng dụng nói “Tạm biệt con nhé”, thoát Luyện nói và trả Main về trạng thái ban đầu.", "P0", "Regression");
add("Luyện nói", "Chuyển chức năng", "Nói Còn cái gì khác để học không", `${online}; Luyện nói đang chờ người dùng`, steps("Nói Còn cái gì khác để học không"), "Câu chuyển chức năng", "Không dịch câu này; thoát Luyện nói và mở menu Chủ đề/Từ vựng/Dịch.", "P0", "Regression");
add("Luyện nói", "Chuyển chức năng", "Chọn Chủ đề từ menu học khác", `${online}; menu học khác đang mở`, steps("Nói Học theo chủ đề"), "Học theo chủ đề", "Bắt đầu luồng hỏi tuổi; không quay lại dịch câu.", "P1");
add("Luyện nói", "PCM", "Im lặng không gây lỗi thiếu metadata PCM", `${online}; Luyện nói đang ghi/chờ`, steps("Mở micro", "Im lặng đến khi timeout"), "No PCM speech frames", "Không hiển thị lỗi “Thiếu metadata PCM khi finalize Batch Chunks”; kết thúc thân thiện.", "P0", "Regression");
add("Luyện nói", "API lỗi", "Backend trả Server action not found", `${online}; có thể giả lập response lỗi`, steps("Gửi một lượt nói", "Backend trả HTML/404"), "HTTP 404/HTML", "Không hiện FormatException thô; hiển thị thông báo thân thiện và cho thử lại.", "P0", "Negative");
add("Luyện nói", "API lỗi", "Không kết nối được backend", `${apk}; backend không truy cập được`, steps("Bắt đầu một lượt nói", "Chờ xử lý"), "Connection refused/timeout", "Không hiển thị SocketException hoặc 127.0.0.1; có thông báo thân thiện.", "P0", "Recovery");
add("Luyện nói", "Idempotency", "Partial và final không tạo hai kết quả", `${online}; ASR trả partial rồi final`, steps("Nói một câu ngắn", "Theo dõi lịch sử và UI"), "Một utterance", "Chỉ tạo một kết quả, một audio và một bản ghi lịch sử.", "P1", "Integration");
add("Luyện nói", "Chống tự nghe", "Không thu lại audio kết quả", `${online}; loa ngoài lớn`, steps("Nói một câu", "Để audio kết quả phát", "Không nói thêm"), "Speaker feedback", "Audio của ứng dụng không bị ghi thành lượt nói tiếp theo.", "P0", "Integration");

// 5. Translation.
add("Dịch tiếng Anh", "Chọn chế độ", "Chọn Dịch một câu", atHome, steps("Nhấn Main", "Chọn Dịch", "Nói Dịch một câu"), "Dịch một câu", "Bi cô hướng dẫn nói một câu và mở micro sau beep.", "P0");
add("Dịch tiếng Anh", "Một câu", "Dịch câu tiếng Việt hợp lệ", `${online}; chế độ một câu`, steps("Nói Hôm nay con đi học", "Chờ kết quả"), "Hôm nay con đi học", "Bản dịch tiếng Anh đúng nghĩa; hiển thị và phát audio một lần.", "P0");
add("Dịch tiếng Anh", "Một câu", "Câu có tên riêng và dấu câu", `${online}; chế độ một câu`, steps("Nói Xin chào, con là An", "Kiểm tra kết quả"), "Xin chào, con là An.", "Giữ đúng tên An và ngữ nghĩa; không dịch sai tên riêng.", "P1");
add("Dịch tiếng Anh", "Một câu", "Câu dài gần giới hạn ghi âm", `${online}; chế độ một câu`, steps("Nói liên tục một câu dài nhưng rõ", "Chờ xử lý"), "10–15 giây giọng nói", "Ứng dụng dừng an toàn, gửi đủ audio và hiển thị một kết quả hoàn chỉnh.", "P1", "Boundary");
add("Dịch tiếng Anh", "Một câu", "Im lặng", `${online}; chế độ một câu`, steps("Không nói sau beep"), "Silence", "Không gửi audio rỗng; không báo metadata PCM; hướng dẫn nói lại hoặc kết thúc.", "P0", "Negative");
add("Dịch tiếng Anh", "Liên tục", "Dịch hai câu liên tiếp", `${online}; chọn Dịch liên tục`, steps("Nói câu 1", "Chờ audio", "Nói câu 2 sau beep"), "Hai câu khác nhau", "Tạo hai kết quả độc lập theo đúng thứ tự; micro tự chuẩn bị giữa các lượt.", "P0");
add("Dịch tiếng Anh", "Liên tục", "Dừng chế độ dịch liên tục", `${online}; đang ở chế độ liên tục`, steps("Nói Dừng lại hoặc dùng Main theo thiết kế"), "Dừng lại", "Kết thúc chế độ; giải phóng micro; trở về trạng thái Main ban đầu.", "P0");
add("Dịch tiếng Anh", "Mạng", "Mất mạng trong lúc upload", `${online}; có thể ngắt mạng giữa lượt`, steps("Bắt đầu nói", "Ngắt mạng khi đang xử lý"), "Network interrupted", "Không treo vô hạn; phiên được hủy/đánh dấu lỗi; có thể thử lại sau khi có mạng.", "P0", "Recovery");
add("Dịch tiếng Anh", "Response", "Backend trả JSON không hợp lệ", `${online}; mock invalid JSON`, steps("Gửi câu dịch", "Trả response không phải JSON"), "HTML/text response", "Không hiện FormatException kỹ thuật; hiển thị lỗi thân thiện kèm mã hỗ trợ nếu có.", "P0", "Negative");
add("Dịch tiếng Anh", "Beep", "Phát beep sau mọi câu hướng dẫn", `${online}; thực hiện đầy đủ luồng dịch`, steps("Nghe từng prompt", "Ghi nhận thời điểm beep và micro"), "Prompt menu + prompt tiếp tục", "Mỗi prompt cần phản hồi đều phát đúng một beep sau khi nói xong; micro mở sau beep.", "P1", "Regression");

// 6. Topics and lesson intro.
add("Chủ đề & lời mở đầu", "Danh mục tuổi", "Hiển thị đúng nhóm tuổi theo cấu hình trẻ", online, steps("Mở Chủ đề", "Đối chiếu tab tuổi đang chọn"), "Tuổi 4, 6, 9, 12, 14", "Mỗi tuổi chọn đúng nhóm 3–5, 6–7, 8–10, 11–12, 13–15.", "P0");
add("Chủ đề & lời mở đầu", "Danh mục", "Tất cả chủ đề có ảnh và tên", online, steps("Duyệt toàn bộ 5 nhóm tuổi", "Kiểm tra từng thẻ"), "50 chủ đề", "Không có ảnh vỡ, tiêu đề rỗng hoặc chủ đề không mở được.", "P1", "Regression");
add("Chủ đề & lời mở đầu", "Tiến độ", "Hiển thị đúng bài đã học và bài tiếp tục", `${online}; có dữ liệu tiến độ`, steps("Mở danh mục Chủ đề", "Đối chiếu tiến độ thực tế"), "0%, một phần, hoàn thành", "Số bài đã học, dấu hoàn thành và thẻ Tiếp tục học chính xác.", "P1");
add("Chủ đề & lời mở đầu", "Điều hướng AI", "AI mở đúng thẻ chủ đề đã chọn", `${online}; đang ở luồng chọn chủ đề`, steps("Chọn chủ đề số 3 bằng giọng nói", "Quan sát trang mở"), "Chủ đề 3", "Tên, số thứ tự và danh sách bài thuộc đúng chủ đề 3.", "P0", "Integration");
add("Chủ đề & lời mở đầu", "Điều hướng AI", "AI mở đúng bài và màn lời mở đầu", `${online}; đang chờ chọn bài`, steps("Nói Bài số 1", "Chờ Bi cô kết thúc", "Quan sát màn tiếp theo"), "Bài 1", "Mở LessonIntroScreen của bài 1; không bỏ qua thẳng vào luyện câu.", "P0", "Regression");
add("Chủ đề & lời mở đầu", "Intro audio", "Lời mở đầu sử dụng introAudioUrl", `${online}; bài My Name có introAudioUrl`, steps("Điều hướng bằng Bi cô đến My Name", "Theo dõi URL/audio phát"), "A067_T01_L01_OPEN.mp3", "Media player phát đúng introAudioUrl; nội dung nghe là file audio đã thu.", "P0", "Regression");
add("Chủ đề & lời mở đầu", "Intro audio", "Không dùng TTS của Bi cô thay lời mở đầu", `${online}; bài V2 có introAudioUrl`, steps("Mở bài bằng AI", "Phân biệt giọng audio và TTS", "Theo dõi log gọi TTS nếu có"), "My Name", "Sau câu “Bắt đầu học thôi con”, lời mở đầu không gọi speakAndWait/TTS.", "P0", "Regression");
add("Chủ đề & lời mở đầu", "Auto advance", "Tự vào phần luyện sau khi intro audio kết thúc", `${online}; introAudioUrl phát được`, steps("Mở bài", "Không bấm Bỏ qua", "Chờ audio kết thúc"), "Audio intro hợp lệ", "Tự chuyển đúng một lần sang màn bài học; không dừng ở loading.", "P0");
add("Chủ đề & lời mở đầu", "Thiếu audio", "introAudioUrl rỗng", `${online}; bài test có introAudioUrl = null`, steps("Mở bài", "Quan sát trạng thái"), "null", "Không dùng TTS; hiển thị “Không thể phát lời mở đầu” và cho phép Bỏ qua.", "P1", "Negative");
add("Chủ đề & lời mở đầu", "Audio lỗi", "introAudioUrl trả 404 hoặc timeout", `${online}; mock URL lỗi`, steps("Mở bài", "Chờ phát lỗi", "Bấm Bỏ qua"), "HTTP 404/timeout", "Không crash/không TTS fallback; hiển thị lỗi; Bỏ qua mở được bài học.", "P0", "Recovery");
add("Chủ đề & lời mở đầu", "Back", "Quay lại khi intro đang phát", `${online}; intro audio đang phát`, steps("Nhấn Back", "Nghe loa và kiểm tra màn trước"), "Back during playback", "Audio dừng; không tiếp tục tự chuyển màn sau khi đã quay lại.", "P1", "Negative");
add("Chủ đề & lời mở đầu", "Audio handoff", "Không chồng câu Bắt đầu học với intro audio", `${online}; mở bài bằng trợ lý`, steps("Chọn bài", "Nghe toàn bộ chuyển tiếp"), "Assistant TTS → introAudioUrl", "Intro chỉ bắt đầu sau khi Bi cô nói xong; không có hai nguồn tiếng cùng lúc.", "P0", "Integration");
add("Chủ đề & lời mở đầu", "Karaoke", "Bài hát tuổi 6+ mở karaoke sau intro", `${online}; chọn bài hát ở nhóm 6+`, steps("Mở bài hát", "Chờ intro kết thúc", "Chờ đếm ngược 3 giây"), "Song lesson age 6+", "Mở karaoke; bài hát tự phát sau 3 giây; lời chạy đúng timeline.", "P1");
add("Chủ đề & lời mở đầu", "Karaoke", "Nhóm 3–5 giữ luồng luyện câu cho bài hát", `${online}; chọn bài hát nhóm 3–5`, steps("Mở bài hát", "Chờ intro"), "Song lesson age 3–5", "Không mở karaoke dành cho trẻ lớn; đi vào luồng luyện từng câu hiện có.", "P2", "Regression");

// 7. Lesson practice and evaluation.
add("Luyện bài", "Audio mẫu", "Tự phát câu tiếng Anh hiện tại", inLesson, steps("Vào một câu mới", "Nghe audio mẫu"), "Sentence audio URL", "Audio tiếng Anh đúng câu và chỉ phát một lần trước khi mời ghi âm.", "P0");
add("Luyện bài", "Audio tiếng Việt", "Nút nghe tiếng Việt phát đúng audio", inLesson, steps("Bấm Nghe tiếng Việt", "Đối chiếu nội dung"), "Vietnamese audio URL", "Phát đúng câu tiếng Việt; không đổi tiến độ hoặc mở micro ngoài ý muốn.", "P2");
add("Luyện bài", "Beep & micro", "Beep phát trước khi bắt đầu ghi âm", inLesson, steps("Chờ lời hướng dẫn kết thúc", "Nghe beep", "Quan sát micro"), "Ready cue", "Beep phát đúng một lần; micro bắt đầu sau beep, không thu đuôi audio mẫu.", "P0", "Integration");
add("Luyện bài", "Auto stop", "Ghi âm tự dừng tối đa 6 giây", `${inLesson}; micro đã mở`, steps("Nói liên tục hoặc giữ im đến hết giới hạn", "Quan sát timer"), "6 giây", "Ghi âm tự dừng; UI thoát trạng thái ghi; bắt đầu đánh giá đúng một lần.", "P0", "Boundary");
add("Luyện bài", "Nhận diện đúng", "Nói đúng từ Hello", `${inLesson}; câu yêu cầu Hello`, steps("Nói Hello rõ ràng", "Chờ đánh giá"), "Hello", "Được đánh giá đúng; phát “Con làm tốt lắm”; chuyển câu tiếp.", "P0", "Regression");
add("Luyện bài", "Nhận diện đúng", "Nói đúng I'm An dù ngữ điệu khác", `${inLesson}; câu yêu cầu I'm An`, steps("Nói I'm An với ngữ điệu khác mẫu", "Chờ đánh giá"), "I'm An / I am An", "So khớp nội dung chữ; không bắt buộc ngữ điệu; phát chúc mừng.", "P0", "Regression");
add("Luyện bài", "Chuẩn hóa", "Không phân biệt hoa thường và dấu câu", `${inLesson}; câu yêu cầu Hello!`, steps("Nói hello", "Chờ đánh giá"), "hello vs Hello!", "Được coi là đúng sau chuẩn hóa; không yêu cầu nói lại.", "P0", "Regression");
add("Luyện bài", "Nói sai", "Nói câu tiếng Việt không liên quan", `${inLesson}; câu yêu cầu I'm An`, steps("Nói Con muốn ăn cơm", "Chờ đánh giá"), "Con muốn ăn cơm", "Đánh giá sai; nói “Con tập trung học đi”; không phát chúc mừng.", "P0", "Negative");
add("Luyện bài", "Không rõ", "Audio im lặng hoặc không đủ dữ liệu", `${inLesson}; micro đang mở`, steps("Im lặng hoặc tạo audio rất ngắn", "Chờ đánh giá"), "Silence/unclear", "Phân loại Không rõ, không coi là sai; hướng dẫn thử lại; không lưu Luyện lại do câu sai.", "P0", "Negative");
add("Luyện bài", "Thử lại", "Sai lần đầu tự mở micro lại", `${inLesson}; lần thử 1`, steps("Nói sai", "Nghe phản hồi", "Quan sát micro"), "Wrong attempt #1", "Lưu câu vào Luyện lại; phát “Con tập trung học đi”; beep và tự mở lượt ghi mới.", "P0", "Regression");
add("Luyện bài", "Thử lại", "Sai lần thứ hai chuyển câu khác", `${inLesson}; đã sai lần 1`, steps("Nói sai lần 2", "Nghe phản hồi"), "Wrong attempt #2", "Nói “Mình cùng học câu khác nhé!” và chuyển sang câu tiếp theo, không lặp vô hạn.", "P0", "Regression");
add("Luyện bài", "Ngôi sao", "Câu đúng được lưu vào Ngôi sao", `${inLesson}; câu chưa có trong từ vựng`, steps("Nói đúng", "Mở Từ vựng → Ngôi sao"), "Expected English", "Câu xuất hiện một lần trong Ngôi sao với tiếng Anh/Việt đúng.", "P0", "Integration");
add("Luyện bài", "Luyện lại", "Câu sai được lưu vào Luyện lại", `${inLesson}; câu chưa có trong từ vựng`, steps("Nói sai lần đầu", "Mở Từ vựng → Luyện lại"), "Wrong English/Vietnamese", "Câu cần học xuất hiện một lần trong Luyện lại; không lưu câu trẻ nói sai làm nội dung học.", "P0", "Integration");
add("Luyện bài", "Đồng bộ bộ sưu tập", "Câu Luyện lại nói đúng ở lần sau", `${inLesson}; câu đang thuộc Luyện lại`, steps("Học lại câu", "Nói đúng", "Mở hai bộ sưu tập"), "Retry then correct", "Câu được đánh dấu thành công/đưa vào Ngôi sao; không tạo bản ghi trùng.", "P1", "Integration");
add("Luyện bài", "Main pause", "Nhấn giữ Main khi đang ghi âm", `${inLesson}; micro đang ghi`, steps("Nhấn giữ Main", "Chờ tác vụ đánh giá cũ nếu có"), "Pause during recording", "Bản ghi dở bị hủy; đánh giá cũ không cập nhật UI; trạng thái dừng ổn định.", "P0", "Regression");
add("Luyện bài", "Main resume", "Tiếp tục sau pause và nói đúng", `${inLesson}; đã dừng bằng Main`, steps("Nhấn giữ Main lần 2", "Nói đúng khi micro tự mở"), "Resume + correct", "Tạo lượt ghi mới; câu đúng được chúc mừng, không bị kết quả cũ ghi đè.", "P0", "Regression");
add("Luyện bài", "Race condition", "Kết quả backend cũ về sau khi pause", `${inLesson}; có thể trì hoãn API đánh giá`, steps("Gửi lượt ghi", "Pause trước khi response về", "Cho response cũ trả về"), "Delayed evaluation", "Response cũ bị bỏ qua; không phát chúc mừng/nhắc sai sau khi đã pause.", "P0", "Integration");
add("Luyện bài", "Main một chạm", "Một chạm Main hỏi có học nữa không", inLesson, steps("Chạm Main một lần", "Nghe phản hồi và beep"), "Tap Main", "Dừng luồng hiện tại an toàn; Bi cô hỏi “Con có muốn học nữa không?” rồi nghe Có/Không.", "P0");
add("Luyện bài", "Xác nhận", "Trả lời Có để tiếp tục học", `${inLesson}; Bi cô đang hỏi có học nữa không`, steps("Nói Có hoặc Dạ có"), "Có; Dạ có", "Bi cô nói “Tiếp tục học nhé con”; tự mở lượt ghi mới.", "P0", "Regression");
add("Luyện bài", "Xác nhận", "Trả lời Không để thoát", `${inLesson}; Bi cô đang hỏi có học nữa không`, steps("Nói Không hoặc Dạ không"), "Không; Dạ không", "Bi cô nói “Tạm biệt con”; dừng audio/micro và quay về trang chủ.", "P0", "Regression");
add("Luyện bài", "Bản ghi", "Phát lại bản ghi của trẻ", `${inLesson}; đã có bản ghi hoàn chỉnh`, steps("Bấm phát bản ghi", "Nghe hết audio"), "Recorded child audio", "Phát đúng bản ghi hiện tại; thời lượng hiển thị hợp lý; không kích hoạt đánh giá lại.", "P2");
add("Luyện bài", "API response", "Backend trả HTML/JSON lỗi", `${inLesson}; mock lỗi server`, steps("Gửi bản ghi", "Trả payload lỗi"), "Invalid JSON/HTML", "Không hiện FormatException; hiển thị thông báo phù hợp trẻ em và cho thử lại.", "P0", "Negative");
add("Luyện bài", "API route", "Route đánh giá chính trả 404", `${inLesson}; mock route chính 404`, steps("Gửi bản ghi", "Quan sát fallback"), "404 evaluate-attempt", "Ứng dụng dùng fallback hợp lệ nếu được cấu hình; không crash và không kết luận sai do lỗi route.", "P0", "Recovery");
add("Luyện bài", "Kết nối", "Backend connection refused", `${inLesson}; backend không khả dụng`, steps("Gửi bản ghi", "Chờ timeout"), "SocketException", "Không hiện địa chỉ 127.0.0.1/stack trace; báo chưa kiểm tra được và cho thử lại.", "P0", "Recovery");
add("Luyện bài", "Tiến độ", "Lưu vị trí câu hiện tại khi thoát", `${inLesson}; đang ở câu 2 trở lên`, steps("Thoát bài", "Mở lại bài"), "Current sentence index", "Tiếp tục đúng câu đã lưu; số câu hoàn thành không bị giảm.", "P1", "Regression");
add("Luyện bài", "Điều hướng câu", "Quay lại câu trước và mở lại ứng dụng", `${inLesson}; có ít nhất 2 câu`, steps("Quay lại câu trước", "Thoát và vào lại"), "Previous sentence", "Vị trí resume theo câu vừa chọn; tổng tiến độ hoàn thành vẫn bảo toàn.", "P2", "Regression");

// 8. Lesson/topic completion.
add("Cuối bài/chủ đề", "Lựa chọn cuối bài", "Hiển thị lựa chọn Học lại/Bài tiếp theo", `${online}; hoàn thành câu cuối`, steps("Hoàn thành câu cuối", "Nghe prompt", "Quan sát lựa chọn"), "End of lesson", "Phát prompt hoàn thành và mở micro/nút lựa chọn đúng; không tự chọn.", "P0");
add("Cuối bài/chủ đề", "Học lại", "Nói Học lại", `${online}; đang chờ lựa chọn cuối bài`, steps("Nói Học lại", "Quan sát bài"), "Học lại; Làm lại", "Bắt đầu lại từ câu 1; không nhân đôi tiến độ hoặc từ vựng.", "P1");
add("Cuối bài/chủ đề", "Bài tiếp theo", "Nói Bài tiếp theo khi còn bài", `${online}; chủ đề còn bài kế tiếp`, steps("Nói Bài tiếp theo"), "Bài tiếp theo", "Mở lời mở đầu bài kế tiếp, sau đó phát introAudioUrl của bài đó.", "P0", "Integration");
add("Cuối bài/chủ đề", "Không rõ", "Lựa chọn cuối bài không rõ", `${online}; đang chờ lựa chọn`, steps("Nói câu không liên quan"), "Con thích màu xanh", "Bi cô nói “Nói lại lựa chọn của con nhé”; tiếp tục nghe; không tự chuyển bài.", "P0", "Negative");
add("Cuối bài/chủ đề", "Hoàn thành chủ đề", "Bài cuối thông báo hoàn thành", `${online}; đang ở bài cuối chủ đề`, steps("Chọn Bài tiếp theo sau khi hoàn thành", "Nghe phản hồi"), "Final lesson", "Thông báo hoàn thành chủ đề; quay về danh sách chủ đề.", "P0", "Regression");
add("Cuối bài/chủ đề", "Chọn lại chủ đề", "Bi cô đọc tổng số N chủ đề", `${online}; vừa hoàn thành chủ đề`, steps("Chờ về danh sách", "Nghe prompt"), "N topics", "Bi cô nói “Có N chủ đề. Con muốn học chủ đề số mấy”; N khớp danh sách.", "P0");
add("Cuối bài/chủ đề", "Beep", "Nghe chọn chủ đề sau beep", `${online}; vừa có prompt N chủ đề`, steps("Chờ prompt kết thúc", "Xác nhận beep", "Nói lựa chọn"), "Chủ đề số 2", "Chỉ bắt đầu nhận lựa chọn sau beep; không mất câu đầu của trẻ.", "P0", "Integration");
add("Cuối bài/chủ đề", "Chủ đề đã học", "Chọn chủ đề hoàn thành", `${online}; ít nhất một chủ đề đã hoàn thành`, steps("Nói số chủ đề đã học"), "Completed topic N", "Bi cô hỏi “Chủ đề số N con đã học rồi. Con có muốn học lại không?”", "P0", "Regression");
add("Cuối bài/chủ đề", "Học lại chủ đề", "Trả lời Có", `${online}; đang xác nhận học lại`, steps("Nói Có/Dạ có/Con muốn học lại"), "Có; Dạ có; Con muốn học lại", "Mở đúng chủ đề cũ; Bi cô hỏi số bài học và mở bài được chọn.", "P0", "Regression");
add("Cuối bài/chủ đề", "Không học lại", "Trả lời Không", `${online}; đang xác nhận học lại`, steps("Nói Không/Dạ không"), "Không; Dạ không", "Không mở chủ đề; Bi cô lặp câu “Có N chủ đề. Con muốn học chủ đề số mấy”.", "P0", "Regression");
add("Cuối bài/chủ đề", "Chủ đề chưa học", "Chọn chủ đề chưa hoàn thành", `${online}; có chủ đề chưa học`, steps("Nói số chủ đề chưa học"), "Unfinished topic", "Mở trực tiếp chủ đề và hỏi số bài; không hỏi xác nhận học lại.", "P0");
add("Cuối bài/chủ đề", "Replay completion", "Hoàn thành lại một chủ đề đã học", `${online}; đang học lại chủ đề hoàn thành`, steps("Học tới bài cuối", "Chọn Bài tiếp theo"), "Replay completed topic", "Vẫn kích hoạt luồng chọn N chủ đề; không bị bỏ qua vì tiến độ đã hoàn thành trước đó.", "P0", "Regression");
add("Cuối bài/chủ đề", "Giá trị không hợp lệ", "Chọn số chủ đề ngoài phạm vi sau hoàn thành", `${online}; đang chờ chọn chủ đề`, steps("Nói Chủ đề số 99"), "99", "Bi cô nêu phạm vi hợp lệ và tiếp tục nghe; không thoát luồng.", "P1", "Negative");
add("Cuối bài/chủ đề", "TTS handoff", "Prompt N chủ đề không bị màn bài cũ dừng", `${online}; hoàn thành bài cuối`, steps("Chọn Bài tiếp theo", "Theo dõi toàn bộ lúc pop route"), "Route transition", "Câu hỏi N chủ đề phát đầy đủ; trạng thái “Bi cô đang nói” kết thúc; beep và micro hoạt động.", "P0", "Regression");

// 9. Vocabulary.
add("Từ vựng", "Điều hướng", "Mở Từ vựng bằng Main", atHome, steps("Nhấn Main", "Nói Học từ vựng"), "Học từ vựng", "Mở trang Từ vựng; hiển thị các hành trình Gia đình/Ngôi sao/Luyện lại theo thiết kế hiện tại.", "P1");
add("Từ vựng", "Thêm mới", "Thêm một từ/câu thủ công", `${online}; ở trang Từ vựng`, steps("Bấm dấu +", "Nhập tiếng Anh và tiếng Việt", "Lưu"), "Family / Gia đình", "Lưu thành công; xuất hiện trong danh sách; dữ liệu giữ đúng dấu tiếng Việt.", "P1");
add("Từ vựng", "Tìm kiếm", "Tìm từ không phân biệt hoa thường", `${online}; có từ Family`, steps("Bấm tìm kiếm", "Nhập family"), "family", "Trả đúng mục Family; không hiện mục không liên quan.", "P2");
add("Từ vựng", "Audio", "Nghe phát âm từ/câu", `${online}; có mục từ vựng`, steps("Bấm biểu tượng loa"), "Saved vocabulary", "Phát đúng tiếng Anh; không mở micro hoặc thay đổi bộ sưu tập.", "P1");
add("Từ vựng", "Ngôi sao", "Hiển thị câu học đúng", `${online}; đã nói đúng ít nhất một câu trong bài`, steps("Mở Ngôi sao", "Đối chiếu bài học"), "Star entry", "Câu đúng xuất hiện, không trùng, có bản dịch và audio phù hợp.", "P0", "Integration");
add("Từ vựng", "Luyện lại", "Hiển thị câu nói sai", `${online}; đã nói sai ít nhất một câu`, steps("Mở Luyện lại", "Đối chiếu câu học"), "Review entry", "Hiển thị câu mục tiêu cần luyện, không lưu nguyên câu sai của trẻ.", "P0", "Integration");
add("Từ vựng", "Số lượng", "Số đếm cập nhật ngay sau khi bài học lưu câu", `${online}; trang từ vựng đã từng mở`, steps("Quay lại bài và nói đúng/sai", "Trở lại Từ vựng"), "New star/review", "Số lượng trên thẻ cập nhật không cần khởi động lại ứng dụng.", "P1", "Regression");
add("Từ vựng", "Lưu trữ", "Dữ liệu tồn tại sau khởi động lại", `${online}; có mục đã lưu`, steps("Đóng hoàn toàn ứng dụng", "Mở lại", "Mở Từ vựng"), "Persisted data", "Các mục Gia đình/Ngôi sao/Luyện lại và số lượng vẫn chính xác.", "P0", "Regression");

// 10. H20 diagnostics.
add("H20 phần cứng", "Giao diện chẩn đoán", "Mở kiểm tra phản ứng H20 offline", `${apk}; phần cứng H20 có thể kết nối`, steps("Mở khu vực kiểm tra H20", "Quan sát trạng thái BLE/HFP/SCO/MAIN"), "H20 diagnostics", "Các trạng thái hiển thị riêng biệt, dễ hiểu; chưa kết nối không bị báo thành đã kết nối.", "P2", "Functional");
add("H20 phần cứng", "Loa offline", "Test loa không gọi cloud", `${apk}; có hoặc không có mạng`, steps("Bấm Test loa offline", "Theo dõi network và âm thanh"), "Bundled audio asset", "Phát audio đóng gói trong APK; không gửi request backend.", "P1", "Integration");
add("H20 phần cứng", "Micro offline", "Ghi thử tối đa 5 giây", `${apk}; H20 đã sẵn sàng; quyền micro đã cấp`, steps("Bấm Thu thử", "Nói", "Chờ 5 giây"), "5-second capture", "Ghi dừng đúng giới hạn; UI không treo; có phản hồi kiểm tra cục bộ.", "P1", "Boundary");
add("H20 phần cứng", "BLE", "Cập nhật trạng thái BLE", `${apk}; bật/tắt thiết bị H20`, steps("Bật BLE và kết nối", "Ngắt kết nối"), "BLE connected/disconnected", "Trạng thái BLE thay đổi đúng và không làm sai HFP/SCO.", "P2", "Compatibility");
add("H20 phần cứng", "HFP/SCO", "Phân biệt HFP và SCO", `${apk}; thiết bị hỗ trợ HFP/SCO`, steps("Kết nối HFP", "Bắt đầu luồng audio SCO", "Kết thúc SCO"), "HFP/SCO states", "HFP và SCO được báo độc lập; không báo SCO hoạt động khi chưa có audio route.", "P1", "Integration");
add("H20 phần cứng", "MAIN packet", "MAIN chưa xác nhận chỉ hiển thị Raw Hex", `${apk}; ODM chưa xác nhận packet MAIN`, steps("Gửi packet thử", "Quan sát hành vi"), "Unconfirmed MAIN packet", "Chỉ hiển thị Raw Hex; không bắt đầu ghi âm hoặc kích hoạt lệnh ngoài ý muốn.", "P0", "Negative");
add("H20 phần cứng", "Offline", "Toàn bộ kiểm tra H20 không gửi âm thanh lên cloud", `${apk}; bật công cụ theo dõi network`, steps("Chạy test loa và micro", "Kiểm tra request"), "Offline diagnostics", "Không upload audio và không gọi backend trong chế độ kiểm tra offline.", "P0", "Security");

// 11. Non-functional and release safeguards.
add("Phi chức năng", "Responsive", "Màn bài học trên điện thoại nhỏ", `${apk}; thiết bị/giả lập 320×568`, steps("Mở intro, luyện câu và cuối bài", "Kiểm tra cuộn/nút"), "320×568", "Không overflow; Main, Bỏ qua và nút ghi âm vẫn thao tác được.", "P1", "Usability");
add("Phi chức năng", "Accessibility", "Cỡ chữ lớn", `${apk}; font scale 1.3–1.5`, steps("Mở các màn chính", "Kiểm tra text và nút"), "Large text scale", "Không mất nội dung quan trọng; nút không chồng; có thể cuộn khi cần.", "P2", "Usability");
add("Phi chức năng", "Dark mode", "Độ tương phản ở giao diện tối", `${apk}; bật Dark mode`, steps("Mở Chủ đề, Intro, Luyện bài, Từ vựng", "Kiểm tra chữ và trạng thái"), "Dark theme", "Chữ, icon, progress và thông báo lỗi dễ đọc; không có chữ tối trên nền tối.", "P2", "Usability");
add("Phi chức năng", "Stress", "Lặp 20 chu kỳ Main–nghe–thoát", `${online}; thiết bị có theo dõi tài nguyên`, steps("Lặp 20 lần mở Main", "Thực hiện hoặc hủy lệnh", "Theo dõi micro/TTS"), "20 cycles", "Không tăng dần độ trễ, không còn session ma, không crash hoặc rò audio focus.", "P1", "Performance");
add("Phi chức năng", "Mạng yếu", "Độ ổn định trên mạng chậm và mất gói", `${apk}; mô phỏng 3G chậm/packet loss`, steps("Thực hiện Luyện nói và đánh giá bài", "Quan sát timeout/retry"), "High latency + packet loss", "Có trạng thái chờ hợp lý; timeout hữu hạn; không gửi trùng và có thể thử lại.", "P1", "Performance");
add("Phi chức năng", "Lifecycle", "Đưa app nền khi đang ghi âm", `${online}; micro đang ghi`, steps("Bấm Home hệ thống", "Chờ", "Quay lại app"), "Background during capture", "Ghi âm được dừng/hủy an toàn theo chính sách; không tự upload audio ngoài ý muốn.", "P0", "Security");
add("Phi chức năng", "Audio focus", "Cuộc gọi/ứng dụng khác giành audio focus", `${online}; đang phát intro hoặc ghi âm`, steps("Mô phỏng audio focus loss", "Khôi phục focus"), "Transient audio interruption", "Audio/micro tạm dừng an toàn; không chồng tiếng; người dùng có thể tiếp tục rõ ràng.", "P1", "Recovery");
add("Phi chức năng", "Soak", "Sử dụng liên tục 30 phút", `${online}; thiết bị thật`, steps("Luân phiên Luyện nói, Chủ đề và Từ vựng 30 phút", "Theo dõi RAM, pin, nhiệt"), "30-minute session", "Không crash/ANR; RAM không tăng bất thường; micro và TTS vẫn hoạt động.", "P2", "Performance");
add("Phi chức năng", "Bảo mật", "Không lộ dữ liệu kỹ thuật nhạy cảm trên UI/log release", `${apk}; tạo lỗi backend`, steps("Gây lỗi mạng/API", "Kiểm tra UI và logcat"), "Errors with request IDs", "Không hiện token, stack trace, đường dẫn nội bộ hay audio base64; mã hỗ trợ có thể hiển thị.", "P0", "Security");
add("Phi chức năng", "Ngôn ngữ", "Toàn bộ prompt trẻ em dùng tiếng Việt tự nhiên", `${online}; ngôn ngữ Việt`, steps("Đi hết các nhánh Main, bài học và lỗi", "Ghi nhận prompt"), "Vietnamese locale", "Không trộn tiếng Trung/chuỗi debug; câu ngắn, phù hợp trẻ em và thống nhất “Bi cô”.", "P2", "Usability");
add("Phi chức năng", "Boundary tuổi", "Kiểm tra các tuổi biên", `${online}; có thể đổi tuổi cấu hình`, steps("Kiểm tra tuổi 3,5,6,7,8,10,11,12,13,15", "Mở Chủ đề"), "Boundary ages", "Mỗi tuổi vào đúng nhóm; không bỏ sót hoặc chồng khoảng tuổi.", "P1", "Boundary");
add("Phi chức năng", "Cấu hình production", "APK production không gọi localhost", `${apk}; theo dõi network`, steps("Chạy Luyện nói, dịch và đánh giá bài", "Kiểm tra host request"), "Production build", "Mọi API gọi backend production Railway; không có request tới 127.0.0.1/localhost.", "P0", "Security");
add("Phi chức năng", "Release", "Xác minh version và chữ ký APK", "Có file APK bàn giao", steps("Dùng aapt/apksigner kiểm tra", "Đối chiếu ghi chú phát hành"), "1.0.4+8", "versionName 1.0.4, versionCode 8; chữ ký v2 hợp lệ; ghi rõ debug certificate chưa dùng cho Play Store.", "P1", "Compatibility");

const modules = [...new Set(cases.map((item) => item.module))];

// Shared colors and helpers.
const colors = {
  navy: "#102A56",
  blue: "#3157D5",
  lightBlue: "#EAF1FF",
  pale: "#F7F9FC",
  green: "#DDF6E8",
  greenText: "#17623A",
  red: "#FDE2E2",
  redText: "#A32121",
  amber: "#FFF1CC",
  amberText: "#8A5A00",
  purple: "#EFE7FF",
  purpleText: "#5F36A5",
  gray: "#E9EDF3",
  grayText: "#475569",
  border: "#D6DEEA",
  white: "#FFFFFF",
};

const styleTitle = (sheet, range) => {
  range.format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white, size: 18 },
    verticalAlignment: "center",
    horizontalAlignment: "left",
  };
  range.format.rowHeight = 34;
};

// Test Cases sheet.
testSheet.showGridLines = false;
testSheet.getRange("A1:Q1").merge();
testSheet.getRange("A1").values = [["INNOTRIK — BỘ TEST CASE TRỢ LÝ AI BI CÔ"]];
styleTitle(testSheet, testSheet.getRange("A1:Q1"));
testSheet.getRange("A2:Q2").merge();
testSheet.getRange("A2").values = [[
  "Phạm vi: Main/Wake word, điều hướng AI, Luyện nói, Dịch tiếng Anh, Chủ đề, bài học, Từ vựng, H20 và kiểm thử phi chức năng. Candidate: production 1.0.4+8.",
]];
testSheet.getRange("A2:Q2").format = {
  fill: colors.lightBlue,
  font: { italic: true, color: colors.navy, size: 10 },
  wrapText: true,
  verticalAlignment: "center",
};
testSheet.getRange("A2:Q2").format.rowHeight = 34;

const testHeaders = [
  "TC_ID",
  "Module",
  "Feature",
  "Test scenario",
  "Preconditions",
  "Test steps",
  "Test data",
  "Expected result",
  "Priority",
  "Test type",
  "Platform",
  "Status",
  "Actual result",
  "Evidence / Bug ID",
  "Tester",
  "Test date",
  "Notes",
];
testSheet.getRange("A4:Q4").values = [testHeaders];
const testRows = cases.map((item) => [
  item.id,
  item.module,
  item.feature,
  item.scenario,
  item.precondition,
  item.steps,
  item.testData,
  item.expected,
  item.priority,
  item.type,
  item.platform,
  "Not Run",
  "",
  "",
  "",
  null,
  "",
]);
const testEndRow = 4 + testRows.length;
testSheet.getRange(`A5:Q${testEndRow}`).values = testRows;
const testTable = testSheet.tables.add(`A4:Q${testEndRow}`, true, "TestCasesTable");
testTable.style = "TableStyleMedium2";
testTable.showBandedRows = true;
testTable.showFilterButton = true;
testSheet.freezePanes.freezeRows(4);
testSheet.freezePanes.freezeColumns(1);
testSheet.getRange(`A4:Q${testEndRow}`).format.font = { name: "Aptos", size: 10, color: "#17233C" };
testSheet.getRange("A4:Q4").format = {
  fill: colors.blue,
  font: { bold: true, color: colors.white, size: 10 },
  wrapText: true,
  verticalAlignment: "center",
  horizontalAlignment: "center",
};
testSheet.getRange("A4:Q4").format.rowHeight = 34;
testSheet.getRange(`A5:Q${testEndRow}`).format.wrapText = true;
testSheet.getRange(`A5:Q${testEndRow}`).format.verticalAlignment = "top";
testSheet.getRange(`A5:Q${testEndRow}`).format.rowHeight = 68;
testSheet.getRange(`A5:A${testEndRow}`).format.horizontalAlignment = "center";
testSheet.getRange(`I5:L${testEndRow}`).format.horizontalAlignment = "center";
testSheet.getRange(`P5:P${testEndRow}`).format.numberFormat = "yyyy-mm-dd";

const testWidths = {
  A: 82, B: 145, C: 145, D: 240, E: 225, F: 330, G: 185, H: 330,
  I: 70, J: 100, K: 82, L: 88, M: 240, N: 155, O: 95, P: 100, Q: 210,
};
for (const [column, width] of Object.entries(testWidths)) {
  testSheet.getRange(`${column}1:${column}${testEndRow}`).format.columnWidthPx = width;
}

testSheet.getRange(`I5:I${testEndRow}`).dataValidation = {
  rule: { type: "list", values: ["P0", "P1", "P2", "P3"] },
};
testSheet.getRange(`J5:J${testEndRow}`).dataValidation = {
  rule: { type: "list", values: ["Functional", "Integration", "Regression", "Negative", "Recovery", "Boundary", "Usability", "Compatibility", "Performance", "Security"] },
};
testSheet.getRange(`K5:K${testEndRow}`).dataValidation = {
  rule: { type: "list", values: ["Android", "Web", "All"] },
};
testSheet.getRange(`L5:L${testEndRow}`).dataValidation = {
  rule: { type: "list", values: ["Not Run", "Passed", "Failed", "Blocked", "N/A"] },
};

const statusRange = testSheet.getRange(`L5:L${testEndRow}`);
statusRange.conditionalFormats.add("containsText", { text: "Passed", format: { fill: colors.green, font: { bold: true, color: colors.greenText } } });
statusRange.conditionalFormats.add("containsText", { text: "Failed", format: { fill: colors.red, font: { bold: true, color: colors.redText } } });
statusRange.conditionalFormats.add("containsText", { text: "Blocked", format: { fill: colors.amber, font: { bold: true, color: colors.amberText } } });
statusRange.conditionalFormats.add("containsText", { text: "Not Run", format: { fill: colors.gray, font: { color: colors.grayText } } });
const priorityRange = testSheet.getRange(`I5:I${testEndRow}`);
priorityRange.conditionalFormats.add("containsText", { text: "P0", format: { fill: colors.red, font: { bold: true, color: colors.redText } } });
priorityRange.conditionalFormats.add("containsText", { text: "P1", format: { fill: colors.amber, font: { bold: true, color: colors.amberText } } });
priorityRange.conditionalFormats.add("containsText", { text: "P2", format: { fill: colors.lightBlue, font: { color: colors.navy } } });

// Dashboard.
dashboard.showGridLines = false;
dashboard.getRange("A1:Q2").merge();
dashboard.getRange("A1").values = [["INNOTRIK — QA TEST DASHBOARD"]];
styleTitle(dashboard, dashboard.getRange("A1:Q2"));
dashboard.getRange("A3:Q3").merge();
dashboard.getRange("A3").values = [["Cập nhật Status trong sheet Test Cases; các chỉ số và biểu đồ sẽ tự tính lại."]];
dashboard.getRange("A3:Q3").format = { fill: colors.lightBlue, font: { italic: true, color: colors.navy }, verticalAlignment: "center" };
dashboard.getRange("A3:Q3").format.rowHeight = 26;

dashboard.getRange("A5:H6").values = [
  ["Tổng test case", null, "P0", null, "P1", null, "Phiên bản", null],
  [null, null, null, null, null, null, "1.0.4+8", null],
];
dashboard.getRange("A6").formulas = [[`=COUNTA('Test Cases'!$A$5:$A$300)`]];
dashboard.getRange("C6").formulas = [[`=COUNTIF('Test Cases'!$I$5:$I$300,"P0")`]];
dashboard.getRange("E6").formulas = [[`=COUNTIF('Test Cases'!$I$5:$I$300,"P1")`]];
for (const range of ["A5:B6", "C5:D6", "E5:F6", "G5:H6"]) {
  dashboard.getRange(range).format = {
    fill: colors.pale,
    font: { color: colors.navy, size: 11 },
    borders: { preset: "outside", style: "thin", color: colors.border },
    verticalAlignment: "center",
  };
}
dashboard.getRange("A5:H5").format.font = { bold: true, color: colors.navy, size: 10 };
dashboard.getRange("A6:F6").format.font = { bold: true, color: colors.blue, size: 18 };
dashboard.getRange("G6:H6").format.font = { bold: true, color: colors.blue, size: 15 };
dashboard.getRange("A5:H6").format.rowHeight = 30;

dashboard.getRange("A8:B8").values = [["Trạng thái", "Số lượng"]];
const statuses = ["Not Run", "Passed", "Failed", "Blocked", "N/A"];
dashboard.getRange("A9:A13").values = statuses.map((value) => [value]);
dashboard.getRange("B9").formulas = [[`=COUNTIF('Test Cases'!$L$5:$L$300,A9)`]];
dashboard.getRange("B9:B13").fillDown();
dashboard.getRange("A15:B17").values = [
  ["Đã thực thi", null],
  ["Tỷ lệ thực thi", null],
  ["Tỷ lệ đạt", null],
];
dashboard.getRange("B15").formulas = [["=B10+B11+B12"]];
dashboard.getRange("B16").formulas = [["=IFERROR(B15/(B6-B13),0)"]];
dashboard.getRange("B17").formulas = [["=IFERROR(B10/(B10+B11),0)"]];
dashboard.getRange("B16:B17").format.numberFormat = "0.0%";

dashboard.getRange("D8:E8").values = [["Module", "Số test"]];
dashboard.getRange(`D9:D${8 + modules.length}`).values = modules.map((value) => [value]);
dashboard.getRange("E9").formulas = [[`=COUNTIF('Test Cases'!$B$5:$B$300,D9)`]];
dashboard.getRange(`E9:E${8 + modules.length}`).fillDown();

dashboard.getRange("G8:H8").values = [["Priority", "Số test"]];
dashboard.getRange("G9:G12").values = [["P0"], ["P1"], ["P2"], ["P3"]];
dashboard.getRange("H9").formulas = [[`=COUNTIF('Test Cases'!$I$5:$I$300,G9)`]];
dashboard.getRange("H9:H12").fillDown();

for (const headerRange of ["A8:B8", "D8:E8", "G8:H8"]) {
  dashboard.getRange(headerRange).format = { fill: colors.blue, font: { bold: true, color: colors.white }, horizontalAlignment: "center" };
}
dashboard.getRange("A9:B17").format.borders = { preset: "inside", style: "thin", color: colors.border };
dashboard.getRange(`D9:E${8 + modules.length}`).format.borders = { preset: "inside", style: "thin", color: colors.border };
dashboard.getRange("G9:H12").format.borders = { preset: "inside", style: "thin", color: colors.border };
dashboard.getRange("A8:H20").format.font = { name: "Aptos", size: 10, color: "#17233C" };
dashboard.getRange("A1:A20").format.columnWidthPx = 150;
dashboard.getRange("B1:B20").format.columnWidthPx = 90;
dashboard.getRange("C1:C20").format.columnWidthPx = 30;
dashboard.getRange("D1:D20").format.columnWidthPx = 190;
dashboard.getRange("E1:E20").format.columnWidthPx = 80;
dashboard.getRange("F1:F20").format.columnWidthPx = 30;
dashboard.getRange("G1:G20").format.columnWidthPx = 95;
dashboard.getRange("H1:H20").format.columnWidthPx = 85;
dashboard.freezePanes.freezeRows(3);

const statusChart = dashboard.charts.add("doughnut", dashboard.getRange("A8:B13"));
statusChart.title = "Tiến độ thực thi";
statusChart.hasLegend = true;
statusChart.setPosition("J5", "Q17");
const moduleChart = dashboard.charts.add("bar", dashboard.getRange(`D8:E${8 + modules.length}`));
moduleChart.title = "Số test theo module";
moduleChart.hasLegend = false;
moduleChart.xAxis = { axisType: "textAxis", textStyle: { fontSize: 9 } };
moduleChart.yAxis = { numberFormatCode: "0" };
moduleChart.setPosition("J19", "Q38");

// Test Data.
dataSheet.showGridLines = false;
dataSheet.getRange("A1:F1").merge();
dataSheet.getRange("A1").values = [["TEST DATA — GIỌNG NÓI, THIẾT BỊ VÀ MẠNG"]];
styleTitle(dataSheet, dataSheet.getRange("A1:F1"));
dataSheet.getRange("A2:F2").merge();
dataSheet.getRange("A2").values = [["Dùng dữ liệu này để chạy lại các ca nhận diện theo nhiều cách nói, giọng trẻ em và điều kiện môi trường."]];
dataSheet.getRange("A2:F2").format = { fill: colors.lightBlue, font: { italic: true, color: colors.navy }, wrapText: true };
const dataHeaders = ["Data ID", "Nhóm", "Input / Điều kiện", "Biến thể", "Kết quả mong đợi", "Ghi chú"];
dataSheet.getRange("A4:F4").values = [dataHeaders];
const utteranceRows = [
  ["VD-001", "Wake word", "Hey Pico", "Hey Piko; Pico ơi", "Kích hoạt trợ lý", "Đọc bằng giọng trẻ em nam/nữ"],
  ["VD-002", "Menu", "Con muốn luyện nói", "Luyện nói; Nói chuyện", "Mở Luyện nói", ""],
  ["VD-003", "Menu", "Con muốn học theo chủ đề", "Học chủ đề; Chủ đề", "Bắt đầu hỏi tuổi", ""],
  ["VD-004", "Menu", "Con muốn học từ vựng", "Học từ mới; Từ mới", "Mở Từ vựng", ""],
  ["VD-005", "Menu", "Con muốn dịch sang tiếng Anh", "Dịch; Dịch tiếng Anh", "Mở menu dịch", ""],
  ["VD-006", "Tuổi", "Con 4 tuổi", "Bốn tuổi", "Nhóm 3–5", ""],
  ["VD-007", "Tuổi", "Con 6 tuổi", "Sáu tuổi", "Nhóm 6–7", ""],
  ["VD-008", "Tuổi", "Con 10 tuổi", "Mười tuổi", "Nhóm 8–10", "Tuổi biên"],
  ["VD-009", "Chủ đề", "Chủ đề số 3", "Con chọn chủ đề ba", "Chọn topic 3", ""],
  ["VD-010", "Bài", "Bài số 1", "Con học bài một", "Chọn lesson 1", ""],
  ["VD-011", "Xác nhận Có", "Có", "Dạ có; Có ạ; Con muốn học lại", "Affirmative", ""],
  ["VD-012", "Xác nhận Không", "Không", "Dạ không; Không ạ; Không đâu", "Negative", ""],
  ["VD-013", "Cuối bài", "Bài tiếp theo", "Bài sau; Qua bài mới", "Next lesson", ""],
  ["VD-014", "Cuối bài", "Học lại", "Làm lại bài này; Học từ đầu", "Restart lesson", ""],
  ["VD-015", "Điều khiển", "Dừng lại", "Thôi; Không học nữa", "Stop", "Chỉ dùng trong cửa sổ lệnh"],
  ["VD-016", "Chuyển chức năng", "Còn cái gì khác để học không", "Con muốn học cái khác", "Mở menu học khác", "Không dịch như câu thường"],
  ["VD-017", "Câu đúng", "Hello", "hello; HELLO", "Good", "Expected: Hello!"],
  ["VD-018", "Câu đúng", "I'm An", "I am An; im an", "Good", "Bỏ qua dấu câu/ngữ điệu"],
  ["VD-019", "Câu sai", "Con muốn ăn cơm", "Câu tiếng Việt bất kỳ", "Retry", "Expected: I'm An"],
  ["VD-020", "Không rõ", "Im lặng", "Âm rất nhỏ; nhiễu", "Unclear", "Không coi là sai"],
  ["ENV-001", "Mạng", "Online ổn định", "Wi-Fi/4G", "Thành công", ""],
  ["ENV-002", "Mạng", "Offline", "Airplane mode", "Lỗi thân thiện", ""],
  ["ENV-003", "Mạng", "Latency 2–5 giây", "Packet loss 10%", "Timeout/retry an toàn", ""],
  ["ENV-004", "Backend", "HTTP 404 + HTML", "Server action not found", "Không FormatException", ""],
  ["ENV-005", "Backend", "Connection refused", "SocketException", "Không lộ 127.0.0.1", ""],
  ["AUD-001", "Audio", "Loa ngoài 100%", "Echo mạnh", "Không tự nghe", ""],
  ["AUD-002", "Audio", "Tai nghe Bluetooth", "HFP/SCO", "Audio route đúng", ""],
  ["AUD-003", "Micro", "Nhiễu lớp học", "Trẻ nói cách micro 1 m", "Không điều hướng sai", ""],
  ["AUD-004", "Micro", "Nói ngay trước beep", "Nói chen", "Không xử lý", ""],
  ["AUD-005", "Micro", "Nói ngay sau beep", "Từ đầu ngắn", "Không mất âm đầu", ""],
  ["URL-001", "Intro", "A067_T01_L01_OPEN.mp3", "Cloudinary HTTP 200", "Phát audio My Name", "Từ introAudioUrl"],
  ["URL-002", "Intro", "introAudioUrl = null", "Không có asset", "Hiện lỗi + Bỏ qua", "Không dùng TTS"],
];
dataSheet.getRange(`A5:F${4 + utteranceRows.length}`).values = utteranceRows;
const dataTable = dataSheet.tables.add(`A4:F${4 + utteranceRows.length}`, true, "TestDataTable");
dataTable.style = "TableStyleMedium2";
dataSheet.freezePanes.freezeRows(4);
dataSheet.getRange(`A4:F${4 + utteranceRows.length}`).format.wrapText = true;
dataSheet.getRange(`A5:F${4 + utteranceRows.length}`).format.rowHeight = 42;
for (const [column, width] of Object.entries({ A: 85, B: 120, C: 220, D: 220, E: 200, F: 210 })) {
  dataSheet.getRange(`${column}1:${column}${4 + utteranceRows.length}`).format.columnWidthPx = width;
}

// Traceability generated from test cases.
traceSheet.showGridLines = false;
traceSheet.getRange("A1:G1").merge();
traceSheet.getRange("A1").values = [["TRACEABILITY — PHẠM VI VÀ ĐỘ BAO PHỦ"]];
styleTitle(traceSheet, traceSheet.getRange("A1:G1"));
traceSheet.getRange("A4:G4").values = [["REQ_ID", "Module", "Yêu cầu kiểm thử", "Mức rủi ro", "Test Cases", "Coverage count", "Ghi chú"]];
const requirementByModule = {
  "Cài đặt & vòng đời": "Cài đặt, nâng cấp, quyền micro và lifecycle phải an toàn.",
  "Main & Wake word": "Main độc lập, không chồng TTS/micro và nghe sau beep.",
  "Điều hướng AI": "Dẫn dắt đúng chức năng, tuổi, chủ đề và bài học.",
  "Luyện nói": "Ghi âm–dịch–phát âm–lượt mới và timeout 10 giây hoạt động ổn định.",
  "Dịch tiếng Anh": "Dịch một câu/liên tục đúng và xử lý lỗi backend thân thiện.",
  "Chủ đề & lời mở đầu": "Điều hướng đúng bài; lời mở đầu bắt buộc phát introAudioUrl, không TTS.",
  "Luyện bài": "Đánh giá đúng/sai/không rõ, retry, Main pause/resume và lưu từ vựng.",
  "Cuối bài/chủ đề": "Hoàn thành, học lại và chọn chủ đề sau bài cuối đúng trạng thái.",
  "Từ vựng": "Ngôi sao/Luyện lại được lưu, hiển thị và đồng bộ chính xác.",
  "H20 phần cứng": "Kiểm tra offline BLE/HFP/SCO/MAIN không gọi cloud.",
  "Phi chức năng": "Ứng dụng ổn định, bảo mật, dễ dùng và đúng cấu hình production.",
};
const traceRows = modules.map((module, index) => {
  const ids = cases.filter((item) => item.module === module).map((item) => item.id);
  const risk = cases.some((item) => item.module === module && item.priority === "P0") ? "Cao" : "Trung bình";
  return [`REQ-${String(index + 1).padStart(2, "0")}`, module, requirementByModule[module], risk, ids.join(", "), null, ""];
});
traceSheet.getRange(`A5:G${4 + traceRows.length}`).values = traceRows;
traceSheet.getRange("F5").formulas = [[`=COUNTIF('Test Cases'!$B$5:$B$300,B5)`]];
traceSheet.getRange(`F5:F${4 + traceRows.length}`).fillDown();
const traceTable = traceSheet.tables.add(`A4:G${4 + traceRows.length}`, true, "TraceabilityTable");
traceTable.style = "TableStyleMedium2";
traceSheet.freezePanes.freezeRows(4);
traceSheet.getRange(`A4:G${4 + traceRows.length}`).format.wrapText = true;
traceSheet.getRange(`A5:G${4 + traceRows.length}`).format.rowHeight = 64;
for (const [column, width] of Object.entries({ A: 80, B: 170, C: 330, D: 95, E: 430, F: 100, G: 180 })) {
  traceSheet.getRange(`${column}1:${column}${4 + traceRows.length}`).format.columnWidthPx = width;
}

// Defect log template.
defectSheet.showGridLines = false;
defectSheet.getRange("A1:M1").merge();
defectSheet.getRange("A1").values = [["DEFECT LOG — INNOTRIK / BI CÔ"]];
styleTitle(defectSheet, defectSheet.getRange("A1:M1"));
defectSheet.getRange("A2:M2").merge();
defectSheet.getRange("A2").values = [["Một defect phải có TC liên kết, môi trường, bằng chứng và kết quả mong đợi/thực tế rõ ràng."]];
defectSheet.getRange("A2:M2").format = { fill: colors.lightBlue, font: { italic: true, color: colors.navy } };
const defectHeaders = ["Defect ID", "Title", "Linked TC", "Severity", "Priority", "Status", "Environment", "Steps to reproduce", "Expected", "Actual", "Evidence", "Owner", "Created date"];
defectSheet.getRange("A4:M4").values = [defectHeaders];
const defectRows = Array.from({ length: 30 }, (_, index) => [`DEF-${String(index + 1).padStart(3, "0")}`, "", "", "", "", "New", "", "", "", "", "", "", null]);
defectSheet.getRange("A5:M34").values = defectRows;
const defectTable = defectSheet.tables.add("A4:M34", true, "DefectLogTable");
defectTable.style = "TableStyleMedium2";
defectSheet.freezePanes.freezeRows(4);
defectSheet.getRange("A5:M34").format.wrapText = true;
defectSheet.getRange("A5:M34").format.rowHeight = 54;
defectSheet.getRange("D5:D34").dataValidation = { rule: { type: "list", values: ["Critical", "Major", "Minor", "Trivial"] } };
defectSheet.getRange("E5:E34").dataValidation = { rule: { type: "list", values: ["P0", "P1", "P2", "P3"] } };
defectSheet.getRange("F5:F34").dataValidation = { rule: { type: "list", values: ["New", "Assigned", "In Progress", "Ready to Retest", "Reopened", "Closed", "Rejected"] } };
defectSheet.getRange("M5:M34").format.numberFormat = "yyyy-mm-dd";
for (const [column, width] of Object.entries({ A: 85, B: 220, C: 95, D: 90, E: 70, F: 110, G: 180, H: 300, I: 240, J: 240, K: 150, L: 100, M: 105 })) {
  defectSheet.getRange(`${column}1:${column}34`).format.columnWidthPx = width;
}

// Guide sheet.
guideSheet.showGridLines = false;
guideSheet.getRange("A1:F1").merge();
guideSheet.getRange("A1").values = [["HƯỚNG DẪN THỰC THI TEST"]];
styleTitle(guideSheet, guideSheet.getRange("A1:F1"));
const guideRows = [
  ["Thông tin", "Ứng dụng", "INNOTRIK — phần mềm học tiếng Anh giao tiếp cho trẻ em"],
  ["Thông tin", "Candidate", "APK production 1.0.4+8 (versionCode 8)"],
  ["Thông tin", "Backend", "https://speaking-ai-nextjs-backend-production.up.railway.app"],
  ["Thông tin", "Nền tảng chính", "Android API 24+, targetSdk 36"],
  ["Thông tin", "Lưu ý ký APK", "Release hiện dùng Android Debug certificate; không dùng phát hành Play Store"],
  ["Priority", "P0", "Luồng chặn phát hành, mất dữ liệu, crash, sai điều hướng nghiêm trọng, micro/TTS chồng chéo"],
  ["Priority", "P1", "Chức năng chính sai nhưng có thể né hoặc không làm mất dữ liệu"],
  ["Priority", "P2", "Lỗi trung bình/UX; chức năng cốt lõi vẫn dùng được"],
  ["Priority", "P3", "Lỗi nhỏ, thẩm mỹ hoặc cải tiến"],
  ["Status", "Not Run", "Chưa thực thi"],
  ["Status", "Passed", "Kết quả thực tế khớp hoàn toàn Expected result"],
  ["Status", "Failed", "Có ít nhất một bước không đạt; phải tạo Defect ID"],
  ["Status", "Blocked", "Không thể thực thi do môi trường, dữ liệu hoặc phụ thuộc"],
  ["Status", "N/A", "Không áp dụng cho build/môi trường hiện tại"],
  ["Quy trình", "1", "Chuẩn bị đúng precondition và test data"],
  ["Quy trình", "2", "Thực hiện đúng thứ tự bước; không bỏ qua beep/audio/micro state"],
  ["Quy trình", "3", "Ghi Actual result, Status, Evidence và Bug ID"],
  ["Quy trình", "4", "Retest defect trên build sửa; chạy regression các P0/P1 liên quan"],
  ["Entry criteria", "Bắt đầu test", "APK cài được; backend/môi trường xác định; dữ liệu tuổi/chủ đề sẵn sàng; thiết bị có micro và loa"],
  ["Exit criteria", "Cho phép phát hành QA", "100% P0/P1 đã chạy; không còn P0 Failed/Blocked; P1 còn lại có đánh giá rủi ro được chấp thuận"],
  ["Nguồn", "Frontend", "D:\\Code\\HuaMei\\App_noi\\flutter\\9_12th8\\speaking-ai-flutter"],
  ["Nguồn", "Lexicon", "C:\\Users\\DELL\\Documents\\Book1.xlsx"],
];
guideSheet.getRange("A3:C3").values = [["Nhóm", "Mục", "Nội dung"]];
guideSheet.getRange(`A4:C${3 + guideRows.length}`).values = guideRows;
const guideTable = guideSheet.tables.add(`A3:C${3 + guideRows.length}`, true, "GuideTable");
guideTable.style = "TableStyleMedium2";
guideSheet.freezePanes.freezeRows(3);
guideSheet.getRange(`A3:C${3 + guideRows.length}`).format.wrapText = true;
guideSheet.getRange(`A4:C${3 + guideRows.length}`).format.rowHeight = 38;
guideSheet.getRange(`A1:A${3 + guideRows.length}`).format.columnWidthPx = 120;
guideSheet.getRange(`B1:B${3 + guideRows.length}`).format.columnWidthPx = 160;
guideSheet.getRange(`C1:C${3 + guideRows.length}`).format.columnWidthPx = 620;

// Compact verification and visual previews for every sheet.
await fs.mkdir(outputDir, { recursive: true });
const previewDir = path.join(outputDir, "previews");
await fs.mkdir(previewDir, { recursive: true });
const renderSpecs = [
  ["Dashboard", "A1:Q38", "dashboard.png"],
  ["Test Cases", "A1:H18", "test-cases.png"],
  ["Test Data", `A1:F${4 + utteranceRows.length}`, "test-data.png"],
  ["Traceability", `A1:G${4 + traceRows.length}`, "traceability.png"],
  ["Defect Log", "A1:M16", "defect-log.png"],
  ["Huong dan", `A1:C${3 + guideRows.length}`, "guide.png"],
];
for (const [sheetName, range, filename] of renderSpecs) {
  const preview = await workbook.render({ sheetName, range, scale: 1.25, format: "png" });
  await fs.writeFile(path.join(previewDir, filename), new Uint8Array(await preview.arrayBuffer()));
}

const dashboardCheck = await workbook.inspect({
  kind: "table",
  range: "Dashboard!A1:H20",
  include: "values,formulas",
  tableMaxRows: 20,
  tableMaxCols: 8,
  maxChars: 10000,
});
const testCaseCheck = await workbook.inspect({
  kind: "table",
  range: "Test Cases!A1:Q12",
  include: "values,formulas",
  tableMaxRows: 12,
  tableMaxCols: 17,
  maxChars: 16000,
});
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
await fs.writeFile(path.join(outputDir, "verification.txt"), [dashboardCheck.ndjson, testCaseCheck.ndjson, errors.ndjson].join("\n"), "utf8");

const outputPath = path.join(outputDir, "INNOTRIK_Test_Cases_AI_Bi_Co_v1.0.xlsx");
const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);
console.log(JSON.stringify({ outputPath, testCaseCount: cases.length, testEndRow, modules, previewDir }, null, 2));
