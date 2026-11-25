/**
 * The API answers in English (it's also consumed by scripts and other
 * services). People using this UI shouldn't have to read "Batch has been
 * recalled — no further events allowed", so known messages are translated
 * here; anything unknown falls back to the caller's Vietnamese default rather
 * than leaking a raw server string.
 */
const MESSAGES: Array<[RegExp, string]> = [
  [/^Invalid credentials$/, 'Email hoặc mật khẩu không đúng.'],
  [/^Too many (login )?attempts/, 'Bạn thử quá nhiều lần. Vui lòng đợi vài phút rồi thử lại.'],
  [/^Email already registered$/, 'Email này đã có tài khoản. Hãy đăng nhập thay vì đăng ký.'],
  [/^Workspace slug already taken$/, 'Mã không gian này đã có người dùng. Hãy chọn mã khác.'],
  [/^Invitation is invalid or has expired$/, 'Mã mời không hợp lệ, đã được dùng hoặc đã hết hạn. Hãy xin quản trị viên mã mới.'],
  [/^This invitation was issued for a different email address$/, 'Mã mời này dành cho một email khác.'],
  [/^Invitation not found, already used or already revoked$/, 'Lời mời đã được dùng hoặc đã bị thu hồi.'],
  [/^Batch not found$/, 'Không tìm thấy lô hàng.'],
  [/^Batch has been recalled/, 'Lô hàng đã bị thu hồi — không thể ghi thêm sự kiện.'],
  [/^Batch has already been recalled$/, 'Lô hàng này đã được thu hồi trước đó.'],
  [/^This batch has not been handed off to you yet$/, 'Lô hàng chưa được bàn giao cho bạn.'],
  [/^You must designate who handles the next stage/, 'Hãy chọn người tiếp nhận khâu tiếp theo.'],
  [/^Assigned actor account is inactive$/, 'Tài khoản người tiếp nhận đang bị khoá.'],
  [/^Assigned actor not found$/, 'Không tìm thấy người tiếp nhận.'],
  [/cannot handle stage/, 'Người được chọn không phụ trách khâu tiếp theo.'],
  [/is not permitted to record stage/, 'Vai trò của bạn không được ghi khâu này.'],
  [/^Current password is incorrect$/, 'Mật khẩu hiện tại không đúng.'],
  [/^Cannot deactivate your own account$/, 'Bạn không thể tự khoá tài khoản của mình.'],
  [/^Cannot change your own role/, 'Bạn không thể tự đổi vai trò của mình — nhờ quản trị viên khác.'],
  [/^Anomaly has already been resolved$/, 'Cảnh báo này đã được xử lý.'],
  [/^Validation failed$/, 'Dữ liệu chưa hợp lệ — kiểm tra lại các trường bắt buộc.'],
  // Lot status & custody
  [/is in transit — the receiver must accept it first/, 'Lô đang trên đường bàn giao — bên nhận phải xác nhận trước.'],
  [/is on hold pending investigation/, 'Lô đang bị tạm giữ chờ điều tra — chưa thể ghi tiếp.'],
  [/failed inspection — (rework|only rework)/, 'Lô không đạt kiểm định — chỉ có thể chế biến lại, hạ loại hoặc huỷ.'],
  [/has been destroyed$/, 'Lô đã bị huỷ.'],
  [/^Lot .* has been recalled$/, 'Lô nguyên liệu đã bị thu hồi.'],
  [/^Batch has been fully consumed/, 'Lô đã được dùng hết vào gộp / tách / chế biến.'],
  [/^Batch has completed its journey$/, 'Lô đã hoàn tất hành trình.'],
  [/^Batch is not on hold$/, 'Lô không ở trạng thái tạm giữ.'],
  [/^Batch is [A-Z_]+ and cannot be handed over$/, 'Lô ở trạng thái hiện tại không thể bàn giao.'],
  [/^Batch is [A-Z_]+ and cannot be put on hold$/, 'Lô ở trạng thái hiện tại không thể tạm giữ.'],
  [/^Batch is [A-Z_]+ and cannot be disposed of$/, 'Lô ở trạng thái hiện tại không thể huỷ.'],
  [/^Batch is [A-Z_]+, not in transit$/, 'Lô không còn đang chờ bàn giao.'],
  [/^Only an admin or inspector can (put a lot on hold|release a hold)$/, 'Chỉ quản trị viên hoặc kiểm định viên được tạm giữ / gỡ tạm giữ.'],
  [/^Only an admin, an inspector, or the holder of a rejected lot can dispose/, 'Chỉ quản trị viên, kiểm định viên hoặc người đang giữ lô không đạt mới được huỷ lô.'],
  [/^A hand-over is already waiting for the receiver$/, 'Đã có một lần bàn giao đang chờ bên nhận xác nhận.'],
  [/^The lot is already with this person$/, 'Lô đang ở chỗ người này rồi.'],
  [/^Transfer has already been answered$/, 'Lần bàn giao này đã được trả lời.'],
  [/^This transfer is not addressed to you$/, 'Lần bàn giao này không gửi cho bạn.'],
  [/^Only the sender can cancel this transfer$/, 'Chỉ bên gửi được huỷ lần bàn giao.'],
  [/^receivedQuantity is required to accept$/, 'Nhập khối lượng thực nhận.'],
  [/^More was received than was (sent|shipped)$/, 'Khối lượng nhận không thể lớn hơn khối lượng gửi.'],
  [/^A reason is required to reject$/, 'Cần nêu lý do từ chối.'],
  // Workflow & time
  [/^Required stage .* cannot be skipped|^Required stage/, 'Không được bỏ qua khâu bắt buộc của quy trình.'],
  [/is already past stage/, 'Lô đã qua khâu này rồi.'],
  [/^Stage [A-Z_]+ is not part of this lot/, 'Khâu này không thuộc quy trình của lô.'],
  [/^occurredAt is in the future$/, 'Thời điểm xảy ra không thể ở tương lai.'],
  [/^occurredAt is earlier than what this lot already went through$/, 'Thời điểm xảy ra sớm hơn khâu lô đã trải qua.'],
  [/a lateReason is required/, 'Ghi nhận quá trễ so với thực tế — hãy nêu lý do ghi muộn.'],
  [/cannot start a lot in workflow/, 'Vai trò của bạn không được tạo lô theo quy trình này.'],
  [/^Role [A-Z_]+ cannot perform/, 'Vai trò của bạn không được thực hiện thao tác này.'],
  [/^IMPORTER cannot handle stage/, 'Bên nhập khẩu xác nhận qua link nhận hàng, không qua bàn giao.'],
  // Transformations
  [/^Only \S+ \S+ of .* remain$/, 'Lô không còn đủ số lượng.'],
  [/^A merge takes at least two/, 'Gộp cần ít nhất hai lô đầu vào.'],
  [/^A split takes one input lot/, 'Tách cần đúng một lô đầu vào và ít nhất hai lô đầu ra.'],
  [/^Input lots follow different workflows/, 'Các lô đầu vào theo quy trình khác nhau, không gộp được.'],
  [/^The same input lot is listed twice$/, 'Một lô đầu vào bị chọn hai lần.'],
  [/keep the product type — use a transformation/, 'Gộp / tách / chế biến lại giữ nguyên loại sản phẩm — đổi loại thì dùng "Chế biến thành sản phẩm khác".'],
  [/changes the product type — use rework/, 'Thao tác này đổi loại sản phẩm — hãy dùng chế biến lại hoặc gộp/tách.'],
  [/^A downgrade stays within the same product group$/, 'Hạ loại phải trong cùng nhóm sản phẩm.'],
  [/is for a lot that failed inspection/, 'Chế biến lại / hạ loại chỉ dành cho lô không đạt kiểm định.'],
  [/is not linked to the product catalog yet/, 'Lô chưa được gắn loại sản phẩm — quản trị viên cần gán trong Danh mục trước.'],
  // Catalog
  [/^Unknown product type/, 'Không tìm thấy loại sản phẩm trong danh mục.'],
  [/^Unit .* is not valid/, 'Đơn vị không dùng được cho loại sản phẩm này.'],
  [/^How many \S+ is one/, 'Đơn vị này chưa có hệ số quy đổi — hãy nhập hệ số.'],
  [/^Workflow .* is not for /, 'Quy trình không dành cho loại sản phẩm này.'],
  [/^Product type code or name already exists$/, 'Mã hoặc tên loại sản phẩm đã tồn tại.'],
  [/^Only an admin can change the catalog$/, 'Chỉ quản trị viên được sửa danh mục.'],
  [/^Unit .* already exists/, 'Đơn vị này đã có cho loại sản phẩm.'],
  [/^Ratios must satisfy/, 'Tỉ lệ phải thoả 0 < thấp nhất ≤ cao nhất.'],
  // Receipt
  [/^Receipt link is invalid or has expired$/, 'Link nhận hàng không hợp lệ hoặc đã hết hạn / The receipt link is invalid or has expired.'],
  [/^Receipt has already been confirmed$/, 'Đã xác nhận nhận hàng trước đó / Receipt already confirmed.'],
  [/^The lot has not been exported yet$/, 'Lô chưa được xuất khẩu.'],
  [/^Only the exporter can issue a receipt link$/, 'Chỉ doanh nghiệp xuất khẩu được tạo link nhận hàng.'],
]

type Issue = { field?: string; code?: string; message?: string }

type ApiErr = { response?: { status?: number; data?: { error?: string; issues?: Issue[] } }; message?: string }

export function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as ApiErr
  const raw = e?.response?.data?.error
  if (!e?.response) return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.'
  if (raw) {
    for (const [pattern, text] of MESSAGES) if (pattern.test(raw)) return text
  }
  // Stage data checked against the product's field schema: name the fields.
  const issues = e.response.data?.issues
  if (issues?.length) {
    const fields = [...new Set(issues.map((i) => i.field).filter(Boolean))]
    return `Thông tin khâu chưa hợp lệ${fields.length ? ` ở trường: ${fields.join(', ')}` : ''}. Kiểm tra lại các trường bắt buộc và định dạng.`
  }
  if (e.response.status === 403) return 'Bạn không có quyền thực hiện thao tác này.'
  return fallback
}
