require('dotenv').config();

const mysql = require('mysql2/promise');
const { getDbConfig } = require('../js/db_config');

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3101';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function login(email) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test@12345' })
  });
  assert(response.status === 200, `Đăng nhập ${email} thất bại: ${response.status}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, `Không nhận được session cookie cho ${email}`);
  return cookie;
}

async function request(path, cookie, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options, headers });
  return response;
}

async function postForm(path, cookie, fields) {
  return request(path, cookie, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  });
}

(async () => {
  let connection;
  let orderId;
  let serviceId;
  let reviewId;
  let scheduleId;
  let rejectedOrderId;
  let rejectScheduleId;
  try {
    connection = await mysql.createConnection(getDbConfig());
    const [[admin]] = await connection.query("SELECT id FROM `user` WHERE email='admin.seed@eventdecor.test'");
    const [[customer]] = await connection.query("SELECT id FROM `user` WHERE email='anna.customer@eventdecor.test'");
    const [[reporter]] = await connection.query("SELECT id FROM `user` WHERE email='bao.customer@eventdecor.test'");
    const [[partner]] = await connection.query("SELECT p.id FROM partners p JOIN `user` u ON u.id=p.user_id WHERE u.email='party.partner@eventdecor.test'");
    assert(admin && customer && reporter && partner, 'Thiếu dữ liệu seed để chạy smoke workflow.');

    const [serviceResult] = await connection.query(
      `INSERT INTO services (partner_id,title,price,status,short_desc)
       VALUES (?, '[SMOKE] Dịch vụ kiểm duyệt', 1000000, 'pending', 'Dữ liệu kiểm thử tự động')`,
      [partner.id]
    );
    serviceId = serviceResult.insertId;
    const anonymousAdmin = await request('/admin', null);
    assert(anonymousAdmin.status === 302, 'Trang admin không chặn người chưa đăng nhập.');

    const adminCookie = await login('admin.seed@eventdecor.test');
    const partnerCookie = await login('party.partner@eventdecor.test');
    const customerCookie = await login('anna.customer@eventdecor.test');
    const reporterCookie = await login('bao.customer@eventdecor.test');

    for (const path of ['/admin', '/admin/services', '/admin/orders', '/admin/finance', '/admin/reviews']) {
      const response = await request(path, adminCookie);
      assert(response.status === 200, `${path} trả về ${response.status}`);
    }
    assert((await request('/partner/dashboard', partnerCookie)).status === 200, 'Cổng đối tác không mở được.');
    assert((await request('/orders', customerCookie)).status === 200, 'Trang theo dõi khách hàng không mở được.');

    let response = await postForm(`/admin/services/${serviceId}/status`, adminCookie, { status: 'active', admin_note: 'Smoke approved' });
    assert(response.status === 302, 'Admin không duyệt được dịch vụ.');

    response = await postForm(`/partner/services/${serviceId}/toggle`, partnerCookie, {});
    assert(response.status === 302, 'Đối tác không ẩn được dịch vụ.');
    response = await postForm(`/partner/services/${serviceId}/toggle`, partnerCookie, {});
    assert(response.status === 302, 'Đối tác không bật lại được dịch vụ.');

    const scheduleDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    response = await postForm('/partner/schedules', partnerCookie, {
      work_date: scheduleDate, start_time: '09:00', end_time: '12:00', note: '[SMOKE] Lịch rảnh'
    });
    assert(response.status === 302, 'Đối tác không tạo được lịch rảnh.');
    [[{ id: scheduleId }]] = await connection.query(
      "SELECT id FROM partner_schedules WHERE partner_id=? AND work_date=? AND start_time='09:00:00'",
      [partner.id, scheduleDate]
    );
    assert(scheduleId, 'Lịch rảnh không được lưu.');

    response = await postForm('/cart/add', customerCookie, { product_id: String(serviceId) });
    assert(response.status === 302, 'Khách hàng không thêm được dịch vụ vào giỏ.');
    assert((await request('/checkout', customerCookie)).status === 200, 'Checkout không hiển thị lịch rảnh.');
    response = await postForm('/checkout', customerCookie, {
      name: 'Smoke Customer', phone: '0900000000', address: 'TP.HCM', method: 'bank',
      note: '[SMOKE] Workflow', [`schedule_${partner.id}`]: String(scheduleId)
    });
    assert(response.status === 302, `Checkout theo lịch thất bại: ${response.status}`);
    const redirectLocation = response.headers.get('location') || '';
    orderId = Number((redirectLocation.match(/new=([0-9]+)/) || [])[1]);
    assert(orderId, 'Không nhận được mã đơn sau checkout.');
    const [[busySchedule]] = await connection.query('SELECT status FROM partner_schedules WHERE id=?', [scheduleId]);
    assert(busySchedule.status === 'busy', 'Lịch không được khóa sau khi khách đặt.');

    response = await postForm(`/admin/orders/${orderId}/status`, adminCookie, { status: 'approved', partner_id: String(partner.id), admin_note: 'Smoke assigned' });
    assert(response.status === 302, 'Admin không duyệt/phân công được đơn.');
    for (const status of ['accepted', 'surveying', 'setup', 'inspection', 'completed']) {
      response = await postForm(`/partner/orders/${orderId}/status`, partnerCookie, { status, partner_note: `Smoke ${status}` });
      assert(response.status === 302, `Đối tác không chuyển được trạng thái ${status}.`);
    }

    response = await postForm(`/orders/${orderId}/review`, customerCookie, { rating: '5', comment: '[SMOKE] Dịch vụ tốt' });
    assert(response.status === 302, 'Khách hàng không đánh giá được đơn hoàn thành.');
    [[{ id: reviewId }]] = await connection.query('SELECT id FROM reviews WHERE order_id=?', [orderId]);
    assert(reviewId, 'Đánh giá không được lưu.');

    response = await postForm(`/partner/reviews/${reviewId}/reply`, partnerCookie, { partner_reply: 'Cảm ơn khách hàng [SMOKE]' });
    assert(response.status === 302, 'Đối tác không phản hồi được đánh giá.');

    response = await postForm(`/reviews/${reviewId}/report`, reporterCookie, { reason: 'Smoke kiểm tra báo cáo vi phạm' });
    assert(response.status === 302, 'Không gửi được báo cáo đánh giá.');
    response = await postForm(`/admin/orders/${orderId}/payout`, adminCookie, {});
    assert(response.status === 302, 'Admin không xác nhận chi trả được.');

    response = await postForm('/partner/schedules', partnerCookie, {
      work_date: scheduleDate, start_time: '13:00', end_time: '15:00', note: '[SMOKE] Lịch từ chối'
    });
    assert(response.status === 302, 'Không tạo được lịch kiểm thử từ chối.');
    [[{ id: rejectScheduleId }]] = await connection.query(
      "SELECT id FROM partner_schedules WHERE partner_id=? AND work_date=? AND start_time='13:00:00'", [partner.id, scheduleDate]
    );
    await postForm('/cart/add', customerCookie, { product_id: String(serviceId) });
    response = await postForm('/checkout', customerCookie, {
      name: 'Smoke Reject', phone: '0900000001', address: 'TP.HCM', method: 'bank',
      note: '[SMOKE] Reject', [`schedule_${partner.id}`]: String(rejectScheduleId)
    });
    rejectedOrderId = Number(((response.headers.get('location') || '').match(/new=([0-9]+)/) || [])[1]);
    assert(rejectedOrderId, 'Không tạo được đơn kiểm thử từ chối.');
    await postForm(`/admin/orders/${rejectedOrderId}/status`, adminCookie, { status: 'approved', partner_id: String(partner.id) });
    response = await postForm(`/partner/orders/${rejectedOrderId}/reject`, partnerCookie, { reason: 'Không đủ nhân sự thực hiện [SMOKE]' });
    assert(response.status === 302, 'Đối tác không từ chối được đơn.');
    const [[rejectedOrder]] = await connection.query('SELECT status FROM orders WHERE id=?', [rejectedOrderId]);
    const [[releasedSchedule]] = await connection.query('SELECT status FROM partner_schedules WHERE id=?', [rejectScheduleId]);
    assert(rejectedOrder.status === 'rejected' && releasedSchedule.status === 'available', 'Từ chối đơn không mở lại lịch rảnh.');

    const [[finalOrder]] = await connection.query('SELECT status,payout_status FROM orders WHERE id=?', [orderId]);
    assert(finalOrder.status === 'completed' && finalOrder.payout_status === 'paid', 'Trạng thái cuối workflow không chính xác.');
    console.log('OK: customer → admin → partner → review/report → payout hoạt động đầy đủ.');
  } finally {
    if (connection) {
      if (reviewId) await connection.query('DELETE FROM review_reports WHERE review_id=?', [reviewId]).catch(() => {});
      if (orderId) {
        await connection.query('DELETE FROM reviews WHERE order_id=?', [orderId]).catch(() => {});
        await connection.query('DELETE FROM order_progress WHERE order_id=?', [orderId]).catch(() => {});
        await connection.query('DELETE FROM order_items WHERE order_id=?', [orderId]).catch(() => {});
        await connection.query('DELETE FROM orders WHERE id=?', [orderId]).catch(() => {});
      }
      if (rejectedOrderId) {
        await connection.query('DELETE FROM order_progress WHERE order_id=?', [rejectedOrderId]).catch(() => {});
        await connection.query('DELETE FROM order_items WHERE order_id=?', [rejectedOrderId]).catch(() => {});
        await connection.query('DELETE FROM orders WHERE id=?', [rejectedOrderId]).catch(() => {});
      }
      if (serviceId) await connection.query('DELETE FROM services WHERE id=?', [serviceId]).catch(() => {});
      if (scheduleId) await connection.query('DELETE FROM partner_schedules WHERE id=?', [scheduleId]).catch(() => {});
      if (rejectScheduleId) await connection.query('DELETE FROM partner_schedules WHERE id=?', [rejectScheduleId]).catch(() => {});
      await connection.query(`UPDATE services s SET s.rating=(SELECT COALESCE(AVG(r.rating),0) FROM reviews r WHERE r.service_id=s.id AND r.status='published'),s.reviews=(SELECT COUNT(*) FROM reviews r WHERE r.service_id=s.id AND r.status='published')`).catch(() => {});
      await connection.end();
    }
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
