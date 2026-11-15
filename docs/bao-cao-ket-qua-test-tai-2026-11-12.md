# Báo cáo kết quả kiểm tra sức chịu tải của tính năng dịch giọng nói

**Ngày kiểm tra:** 12/11/2026
**Môi trường:** máy chủ thử nghiệm (dev), không phải hệ thống người dùng đang dùng

---

## 1. Tóm tắt

- **Câu hỏi:** nếu 500 hoặc 1000 người cùng bấm "dịch" trong cùng 1 giây thì hệ thống có chịu được không?
- **Trả lời:**
  - **Nếu bắt người dùng chờ kết quả ngay:** chưa chịu được. Với 1000 người, chỉ khoảng **1/5 nhận được bản dịch**. Với 500 người, khoảng **6/10 nhận được bản dịch** (sau khi đã thêm một tài khoản AI).
  - **Nếu cho người dùng xếp hàng rồi nhận kết quả sau:** chịu được. **Cả 1000/1000 yêu cầu đều được dịch xong** trong khoảng 4 phút, không yêu cầu nào bị mất.
- **Nguyên nhân chính:** dịch vụ AI bên ngoài (Cloudflare) chỉ cho mỗi tài khoản dịch khoảng **5 câu mỗi giây**. Máy chủ của mình không phải là điểm nghẽn.
- **Kết luận:** trước mắt nhắm mục tiêu chịu được **500 yêu cầu trong 1 giây**, chưa mua ngay 20 tài khoản. Tăng số tài khoản dần theo số sản phẩm bên vận hành bán được và theo mức quá tải thực tế. Chi tiết ở mục 7.

---

## 2. Đã kiểm tra những gì

Mình dùng một công cụ giả lập để gửi cùng lúc rất nhiều bản ghi âm giọng trẻ em lên máy chủ, giống như nhiều người dùng bấm "dịch" cùng một lúc. Mỗi yêu cầu đi qua ba bước:

```
Người dùng gửi ghi âm → Cổng tiếp nhận → Máy chủ của mình → Dịch vụ AI Cloudflare
                                                              (nghe giọng nói, rồi dịch sang tiếng Anh)
```

Mình thử hai cách xử lý:

| Cách | Giống với | Người dùng thấy gì |
|---|---|---|
| **Trả lời ngay** | Gọi điện thoại: phải có người nghe máy ngay | Chờ trên màn hình cho đến khi có bản dịch, hoặc nhận thông báo "hệ thống bận" |
| **Xếp hàng** | Lấy số thứ tự ở ngân hàng | Gửi xong là yên tâm, bản dịch hiện ra khi tới lượt |

---

## 3. Kết quả

### 3.1. Trước và sau khi tối ưu (1000 người cùng lúc, trả lời ngay)

Trước khi tối ưu, "cổng tiếp nhận" quá nhỏ: từ 1/5 đến hơn 1/3 số yêu cầu bị chặn ngay ở cổng, không vào được tới máy chủ. Mình đã mở rộng cổng, tăng sức chứa của máy chủ, rồi kiểm tra lại.

| | Lần 1 – chưa tối ưu (16:00) | Lần 2 – chưa tối ưu (16:43) | Sau khi tối ưu (16:56) |
|---|---|---|---|
| Tổng số yêu cầu gửi | 999 | 1000 | 1000 |
| Yêu cầu vào được tới máy chủ | 779 | 625 | **1000** |
| Nhận được bản dịch | 35 (4%) | 170 (17%) | **220 (22%)** |
| Bị báo lỗi hệ thống | 222 | 381 | **0** |
| Bị báo "hệ thống bận, thử lại sau" | 742 | 449 | 780 |
| Thời gian chờ của người nhận được bản dịch (người ở giữa) | khoảng 5 giây | khoảng 6 giây | khoảng 17 giây |

Ghi chú: lần 1 dùng 6 bản ghi âm khác nhau, các lần sau dùng cùng 1 bản ghi âm. Ở lần 1, công cụ kiểm tra chỉ kịp gửi 999/1000 yêu cầu.

**Ý nghĩa:**

- Trước khi tối ưu, chỉ **35–170 người** nhận được bản dịch, và **22–38%** yêu cầu bị lỗi hệ thống. Kết quả dao động mạnh giữa các lần chạy.
- Sau khi tối ưu, lỗi hệ thống đã hết hoàn toàn và số người nhận được bản dịch tăng lên 220. Những yêu cầu chưa được dịch giờ nhận thông báo "bận, thử lại sau" rõ ràng, thay vì bị lỗi.
- Thời gian chờ dài hơn vì mọi người đều được vào hàng, không bị đuổi ra ngay từ cửa.

### 3.2. Giảm còn 500 người cùng lúc, trả lời ngay

| | 500 người | 1000 người |
|---|---|---|
| Nhận được bản dịch | 158 (32%) | 220 (22%) |
| Bị báo "bận" | 342 | 780 |
| Thời gian chờ (người ở giữa) | khoảng 12 giây | khoảng 17 giây |

**Ý nghĩa:** giảm số người đi một nửa nhưng số người được dịch gần như không đổi. Hệ thống chỉ dịch được khoảng **150–220 yêu cầu cho mỗi đợt dồn**, dù có bao nhiêu người gửi.

### 3.3. Thêm một tài khoản AI (500 người cùng lúc, trả lời ngay)

| | 2 tài khoản AI | 3 tài khoản AI |
|---|---|---|
| Nhận được bản dịch | 158 (32%) | **295 (59%)** |
| Bị báo "bận" | 342 | 205 |
| Thời gian chờ (người ở giữa) | khoảng 12 giây | khoảng 14 giây |

**Ý nghĩa:** chỉ cần thêm 1 tài khoản là số người được dịch **gần gấp đôi**. Đây là bằng chứng rõ nhất cho thấy giới hạn nằm ở dịch vụ AI, không phải ở máy chủ của mình.

### 3.4. Cách xếp hàng (1000 người cùng lúc)

| | Kết quả |
|---|---|
| Yêu cầu được nhận | **1000 / 1000** |
| Yêu cầu được dịch xong | **1000 / 1000**, không yêu cầu nào thất bại |
| Thời gian để dịch xong toàn bộ | khoảng 4 phút |

**Ý nghĩa:** với cách xếp hàng, không ai bị từ chối. Người gửi đầu tiên có kết quả sau vài giây, người gửi cuối cùng phải chờ khoảng 4 phút.

---

## 4. Vì sao chưa phục vụ được cả 1000 người ngay lập tức

- Mỗi bản ghi âm phải nhờ dịch vụ AI Cloudflare làm hai việc: nghe giọng nói, rồi dịch sang tiếng Anh.
- Cloudflare giới hạn mỗi tài khoản khoảng **300 lần dịch mỗi phút, tức khoảng 5 lần mỗi giây**. Giống một quầy giao dịch chỉ có vài nhân viên: khách đến đông cùng lúc thì phải chờ.
- Hệ thống của mình chỉ cho mỗi người chờ tối đa 8 giây. Quá thời gian đó, người dùng nhận thông báo "bận, thử lại sau" để không phải chờ mãi.
- Với 3 tài khoản, hệ thống dịch được khoảng 15 câu mỗi giây. Để 1000 người cùng nhận kết quả ngay thì cần khoảng 100 câu mỗi giây, tức **gấp khoảng 7 lần hiện tại**.

**Lưu ý về chi phí:**

- Mỗi tài khoản Cloudflare Workers trả phí có giá **5 USD/tháng**. Nếu dùng vượt phần miễn phí đi kèm, Cloudflare tính thêm tiền theo mức dùng.
- Trả phí **không tự động** nâng giới hạn "5 câu mỗi giây" của mỗi tài khoản. Muốn dịch nhanh hơn thì phải dùng thêm tài khoản, hoặc gửi yêu cầu riêng để Cloudflare nâng hạn mức.

| Số tài khoản | Chi phí cố định mỗi tháng | Tốc độ dịch | Ước tính với 500 người cùng lúc (trả lời ngay) |
|---|---|---|---|
| 3 (hiện tại) | 15 USD | khoảng 15 câu/giây | khoảng 6/10 người nhận được bản dịch (đã đo) |
| 5–6 | 25–30 USD | khoảng 25–30 câu/giây | gần như tất cả nhận được bản dịch (ước tính, chưa đo) |

---

## 5. Đề xuất

| # | Việc cần làm | Lợi ích | Người cần quyết định |
|---|---|---|---|
| 1 | **Chuyển app sang cách "xếp hàng"** cho tính năng dịch giọng nói | Không người dùng nào bị từ chối khi đông | Sếp duyệt; đội app cần làm thêm màn hình "đang xử lý" |
| 2 | **Thêm tài khoản AI hoặc xin Cloudflare nâng hạn mức** | Mỗi tài khoản thêm giúp dịch nhanh hơn khoảng 5 câu mỗi giây. Để 500 người cùng nhận kết quả ngay, cần khoảng 5–6 tài khoản, tức khoảng **25–30 USD/tháng** | Sếp duyệt chi phí |
| 3 | **Chuyển các tài khoản AI sang gói trả phí** (5 USD/tháng mỗi tài khoản) | Tránh việc tài khoản miễn phí dùng hết lượt trong ngày và ngừng hoạt động | Sếp duyệt chi phí |
| 4 | Sửa một lỗi nhỏ: khoảng 3% yêu cầu ở cách xếp hàng báo "xong" nhưng chưa hiện bản dịch | Người dùng không bị thấy kết quả trống | Đội kỹ thuật |
| 5 | Kiểm tra riêng chất lượng nhận diện giọng trẻ em | Một số bản ghi bị dịch sai nghĩa, ví dụ "con không hiểu" thành "I want to give it to you" | Đội kỹ thuật |

---

## 6. Rủi ro cần biết

- **Máy chủ thử nghiệm đang dùng chung cơ sở dữ liệu với hệ thống thật.** Các đợt kiểm tra lớn có thể làm người dùng thật bị chậm trong vài chục giây. Nên tách riêng trước khi kiểm tra tiếp.
- Các con số trên đo trên máy chủ thử nghiệm. Hệ thống thật cần được cấu hình tương tự thì mới đạt được kết quả này.

---

## 7. Kết luận

### Mục tiêu trước mắt: 500 yêu cầu trong 1 giây

- Bài kiểm tra 1000 yêu cầu trong cùng 1 giây là tình huống cực đoan. Trong thực tế, việc 1000 người bấm "dịch" đúng cùng một giây rất hiếm khi xảy ra.
- Vì vậy, trước mắt chỉ cần hệ thống chịu được **500 yêu cầu trong 1 giây**.
- Có thể mua ngay 20 tài khoản Cloudflare (khoảng 100 USD/tháng) để chịu được mức 1000. Nhưng khi chưa biết bên vận hành bán được bao nhiêu sản phẩm, đó là chi phí bỏ ra trước mà có thể chưa dùng tới.

### Nâng cấp theo doanh số, không mua trước

| Giai đoạn | Khi nào | Số tài khoản | Chi phí/tháng | Khả năng phục vụ |
|---|---|---|---|---|
| 1. Hiện tại | Ngay bây giờ | 3 | 15 USD | 500 yêu cầu cùng lúc: khoảng 6/10 nhận kết quả ngay (đã đo) |
| 2. Đạt mục tiêu 500 | Khi bắt đầu bán, hoặc trước đợt ra mắt lớn | 6 | 30 USD | 500 yêu cầu cùng lúc: gần như tất cả (ước tính, cần kiểm tra lại) |
| 3. Mở rộng | Khi doanh số tăng và hệ thống báo quá tải | thêm dần, tối đa khoảng 20 | tối đa khoảng 100 USD | Gần mức 1000 yêu cầu cùng lúc (ước tính) |

- **Thêm tài khoản nhanh và không phải dừng hệ thống.** Lần thêm tài khoản thứ 3 trong đợt kiểm tra này hoàn tất trong ngày, người dùng không bị gián đoạn. Vì vậy không cần mua trước để phòng xa.
- **Dấu hiệu cần nâng cấp:** đội kỹ thuật theo dõi hằng tuần tỉ lệ người dùng nhận thông báo "hệ thống bận". Khi tỉ lệ này tăng rõ rệt (đề xuất mốc 5%), hoặc khi bên vận hành báo doanh số tăng mạnh, thì thêm tài khoản.
- **Làm song song: chuyển app sang cách "xếp hàng".** Nếu lượng người dùng tăng đột ngột trước khi kịp thêm tài khoản, người dùng chỉ phải chờ lâu hơn chứ không bị từ chối.

### Cần bên vận hành cung cấp

- Số sản phẩm dự kiến bán ra mỗi tháng.
- Thời điểm các đợt ra mắt hoặc khuyến mãi lớn, vì đây là lúc dễ có nhiều người dùng cùng lúc nhất.

Từ hai số liệu này, đội kỹ thuật sẽ tính số tài khoản cần có cho từng giai đoạn.
