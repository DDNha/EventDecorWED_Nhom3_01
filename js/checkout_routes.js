const express = require('express');

module.exports = function createCheckoutRoutes({ pool, SERVICES, isAuthenticated }) {
  const router = express.Router();
  const FEE_RATE = 0.05;
  const COMMISSION_RATE = 10;
  const METHODS = {
    cod: 'Thanh toán khi nghiệm thu',
    bank: 'Chuyển khoản ngân hàng',
    card: 'Thẻ / Ví điện tử'
  };
  const STATUS_LABELS = {
    pending: 'Đã đặt dịch vụ',
    approved: 'Chờ đối tác chấp nhận',
    accepted: 'Đã chấp nhận đơn',
    surveying: 'Khảo sát mặt bằng',
    setup: 'Setup không gian',
    inspection: 'Nghiệm thu',
    completed: 'Hoàn thành',
    rejected: 'Bị từ chối',
    cancelled: 'Đã hủy'
  };
  const TRACKING_STEPS = ['pending', 'approved', 'accepted', 'surveying', 'setup', 'inspection', 'completed'];

  function requireCustomer(req, res, next) {
    if (!req.session.user) return isAuthenticated(req, res, next);
    if (req.session.user.role !== 'user') {
      return res.status(403).send('Chỉ tài khoản khách hàng mới có thể đặt và đánh giá dịch vụ.');
    }
    next();
  }

  function buildLines(sessionCart) {
    const lines = [];
    for (const item of sessionCart || []) {
      const service = SERVICES.find((entry) => Number(entry.id) === Number(item.product_id));
      if (!service) continue;
      const qty = Math.max(1, parseInt(item.qty, 10) || 1);
      const price = Number(service.price);
      lines.push({ service, qty, price, lineTotal: price * qty });
    }
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const fee = Math.round(subtotal * FEE_RATE);
    return { lines, subtotal, fee, total: subtotal + fee };
  }

  function groupLines(lines) {
    const groups = new Map();
    for (const line of lines) {
      const partnerId = Number(line.service.partner_id);
      if (!groups.has(partnerId)) groups.set(partnerId, []);
      groups.get(partnerId).push(line);
    }
    return groups;
  }

  async function getScheduleGroups(lines) {
    const groups = groupLines(lines);
    const result = [];
    for (const [partnerId, partnerLines] of groups) {
      const [slots] = await pool.query(
        `SELECT id,work_date,start_time,end_time,note
         FROM partner_schedules
         WHERE partner_id=? AND status='available' AND work_date>=CURRENT_DATE
         ORDER BY work_date,start_time LIMIT 100`, [partnerId]
      );
      result.push({ partnerId, partnerName: partnerLines[0].service.partner, slots });
    }
    return result;
  }

  function renderCheckout(res, status, summary, form, error, user, scheduleGroups = []) {
    return res.status(status).render('cart_checkout.html', {
      ...summary, methods: METHODS, form, error, user, scheduleGroups
    });
  }

  router.get('/checkout', requireCustomer, async (req, res, next) => {
    const summary = buildLines(req.session.cart);
    if (!summary.lines.length) return res.redirect('/cart');
    try {
      const user = req.session.user;
      const scheduleGroups = await getScheduleGroups(summary.lines);
      return renderCheckout(res, 200, summary, {
        name: user.full_name || user.username,
        phone: user.phone || ''
      }, null, user, scheduleGroups);
    } catch (error) { next(error); }
  });

  router.post('/checkout', requireCustomer, async (req, res) => {
    const summary = buildLines(req.session.cart);
    if (!summary.lines.length) return res.redirect('/cart');

    const form = req.body;
    const name = String(form.name || '').trim();
    const phone = String(form.phone || '').trim();
    const address = String(form.address || '').trim();
    const note = String(form.note || '').trim() || null;
    const groups = groupLines(summary.lines);
    let error = null;

    if (!name || !phone || !address) {
      error = 'Vui lòng nhập đầy đủ họ tên, số điện thoại và địa điểm tổ chức.';
    } else if (!/^[0-9+\s.-]{8,15}$/.test(phone)) {
      error = 'Số điện thoại không hợp lệ.';
    } else if (!METHODS[form.method]) {
      error = 'Vui lòng chọn phương thức thanh toán.';
    } else if (summary.lines.some((line) => !line.service.partner_id)) {
      error = 'Có dịch vụ chưa được liên kết với đối tác. Vui lòng bỏ dịch vụ đó khỏi giỏ hàng.';
    } else if ([...groups.keys()].some((partnerId) => !Number(form[`schedule_${partnerId}`]))) {
      error = 'Vui lòng chọn một lịch rảnh cho từng đối tác.';
    }
    if (error) {
      const scheduleGroups = await getScheduleGroups(summary.lines);
      return renderCheckout(res, 400, summary, form, error, req.session.user, scheduleGroups);
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const orderIds = [];
      for (const [partnerId, lines] of groups) {
        const scheduleId = Number(form[`schedule_${partnerId}`]);
        const [[schedule]] = await connection.query(
          `SELECT id,work_date,start_time,end_time FROM partner_schedules
           WHERE id=? AND partner_id=? AND status='available' AND work_date>=CURRENT_DATE FOR UPDATE`,
          [scheduleId, partnerId]
        );
        if (!schedule) {
          const scheduleError = new Error('Lịch vừa chọn không còn trống. Vui lòng chọn lịch khác.');
          scheduleError.code = 'SCHEDULE_UNAVAILABLE';
          throw scheduleError;
        }
        const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
        const fee = Math.round(subtotal * FEE_RATE);
        const total = subtotal + fee;
        const commission = Math.round(total * COMMISSION_RATE / 100);
        const serviceName = lines.map((line) => line.service.title).join(', ').slice(0, 200);
        const [result] = await connection.query(
          `INSERT INTO orders
           (user_id, partner_id, customer_name, customer_phone, service_name,
            event_date, event_time, event_location, note, total_amount, schedule_id,
            discount_amount, final_amount, payment_method, status, source_role,
            commission_rate, commission_amount, partner_payout)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending', 'customer', ?, ?, ?)`,
          [req.session.user.id, partnerId, name, phone, serviceName, schedule.work_date, schedule.start_time,
            address, note, subtotal, schedule.id, total, METHODS[form.method], COMMISSION_RATE,
            commission, total - commission]
        );
        orderIds.push(result.insertId);
        await connection.query(
          'INSERT INTO order_items (order_id, service_id, quantity, price) VALUES ?',
          [lines.map((line) => [result.insertId, line.service.id, line.qty, line.price])]
        );
        await connection.query(
          `INSERT INTO order_progress (order_id, status, note, actor_id, actor_role)
           VALUES (?, 'pending', ?, ?, 'user')`,
          [result.insertId, 'Khách hàng đã đặt dịch vụ và gửi đơn chờ admin duyệt.', req.session.user.id]
        );
        await connection.query("UPDATE partner_schedules SET status='busy' WHERE id=?", [schedule.id]);
      }
      await connection.commit();
      req.session.cart = [];
      return req.session.save(() => res.redirect(`/orders?new=${orderIds.join(',')}`));
    } catch (databaseError) {
      await connection.rollback();
      console.error('Lỗi tạo đơn hàng:', databaseError);
      const scheduleGroups = await getScheduleGroups(summary.lines);
      return renderCheckout(res, databaseError.code === 'SCHEDULE_UNAVAILABLE' ? 409 : 500, summary, form,
        databaseError.code === 'SCHEDULE_UNAVAILABLE' ? databaseError.message : `Không thể tạo đơn hàng: ${databaseError.sqlMessage || 'vui lòng thử lại.'}`,
        req.session.user, scheduleGroups);
    } finally {
      connection.release();
    }
  });

  router.get('/orders', requireCustomer, async (req, res, next) => {
    try {
      const [orderRows] = await pool.query(
        `SELECT o.*, p.name AS partner_name, r.id AS review_id, r.rating AS review_rating,
                r.comment AS review_comment, r.status AS review_status
         FROM orders o
         LEFT JOIN partners p ON p.id = o.partner_id
         LEFT JOIN reviews r ON r.order_id = o.id
         WHERE o.user_id = ? ORDER BY o.id DESC`,
        [req.session.user.id]
      );
      let itemRows = [];
      let progressRows = [];
      if (orderRows.length) {
        const ids = orderRows.map((order) => order.id);
        [itemRows] = await pool.query(
          `SELECT oi.order_id, oi.service_id, oi.quantity, oi.price,
                  s.title, s.image, p.name AS partner
           FROM order_items oi
           LEFT JOIN services s ON s.id = oi.service_id
           LEFT JOIN partners p ON p.id = s.partner_id
           WHERE oi.order_id IN (?)`, [ids]
        );
        [progressRows] = await pool.query(
          `SELECT order_id, status, note, actor_role, created_at
           FROM order_progress WHERE order_id IN (?) ORDER BY created_at, id`, [ids]
        );
      }
      const orders = orderRows.map((order) => {
        const step = TRACKING_STEPS.indexOf(order.status);
        return {
          ...order,
          status_label: STATUS_LABELS[order.status] || order.status,
          step: step < 0 ? 0 : step,
          steps: TRACKING_STEPS.map((status) => ({ status, label: STATUS_LABELS[status] })),
          items: itemRows.filter((item) => item.order_id === order.id),
          progress: progressRows.filter((entry) => entry.order_id === order.id),
          event_text: order.event_date ? new Date(order.event_date).toLocaleDateString('vi-VN') : 'Chưa cập nhật',
          created_text: new Date(order.created_at).toLocaleString('vi-VN'),
          time_text: order.event_time ? String(order.event_time).slice(0, 5) : '',
          can_cancel: order.status === 'pending',
          can_review: order.status === 'completed' && !order.review_id
        };
      });
      const newIds = String(req.query.new || '').split(',').map(Number).filter(Number.isInteger);
      return res.render('orders.html', { orders, newIds, user: req.session.user, notice: req.query.notice || '' });
    } catch (error) { next(error); }
  });

  router.post('/orders/:id/cancel', requireCustomer, async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[order]] = await connection.query(
        `SELECT schedule_id FROM orders WHERE id=? AND user_id=? AND status='pending' FOR UPDATE`,
        [req.params.id, req.session.user.id]
      );
      if (!order) {
        await connection.rollback();
        return res.status(409).send('Chỉ có thể hủy đơn đang chờ duyệt.');
      }
      const [result] = await connection.query(
        `UPDATE orders SET status = 'cancelled'
         WHERE id = ? AND user_id = ? AND status = 'pending'`,
        [req.params.id, req.session.user.id]
      );
      if (!result.affectedRows) {
        await connection.rollback();
        return res.status(409).send('Chỉ có thể hủy đơn đang chờ duyệt.');
      }
      await connection.query(
        `INSERT INTO order_progress (order_id, status, note, actor_id, actor_role)
         VALUES (?, 'cancelled', ?, ?, 'user')`,
        [req.params.id, String(req.body.note || '').trim() || 'Khách hàng đã hủy đơn.', req.session.user.id]
      );
      if (order.schedule_id) {
        await connection.query("UPDATE partner_schedules SET status='available' WHERE id=? AND status='busy'", [order.schedule_id]);
      }
      await connection.commit();
      return res.redirect('/orders?notice=' + encodeURIComponent('Đã hủy đơn hàng.'));
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally { connection.release(); }
  });

  router.post('/orders/:id/review', requireCustomer, async (req, res, next) => {
    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || '').trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).send('Số sao đánh giá phải từ 1 đến 5.');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[order]] = await connection.query(
        `SELECT o.id, oi.service_id
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
         WHERE o.id = ? AND o.user_id = ? AND o.status = 'completed'
         ORDER BY oi.id LIMIT 1`, [req.params.id, req.session.user.id]
      );
      if (!order) {
        await connection.rollback();
        return res.status(403).send('Đơn hàng chưa hoàn thành hoặc không thuộc tài khoản của bạn.');
      }
      await connection.query(
        `INSERT INTO reviews (order_id, service_id, user_id, rating, comment)
         VALUES (?, ?, ?, ?, ?)`,
        [order.id, order.service_id, req.session.user.id, rating, comment || null]
      );
      await connection.query(
        `UPDATE services s SET
           s.rating = (SELECT COALESCE(AVG(r.rating), 0) FROM reviews r WHERE r.service_id = s.id AND r.status = 'published'),
           s.reviews = (SELECT COUNT(*) FROM reviews r WHERE r.service_id = s.id AND r.status = 'published')
         WHERE s.id = ?`, [order.service_id]
      );
      await connection.commit();
      return res.redirect('/orders?notice=' + encodeURIComponent('Cảm ơn bạn đã đánh giá dịch vụ.'));
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).send('Đơn hàng này đã được đánh giá.');
      next(error);
    } finally { connection.release(); }
  });

  router.post('/reviews/:id/report', isAuthenticated, async (req, res, next) => {
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 5) return res.status(400).send('Vui lòng nhập lý do báo cáo rõ ràng.');
    try {
      await pool.query('INSERT INTO review_reports (review_id, reporter_id, reason) VALUES (?, ?, ?)',
        [req.params.id, req.session.user.id, reason]);
      return res.redirect('/orders?notice=' + encodeURIComponent('Đã gửi báo cáo đánh giá tới admin.'));
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).send('Bạn đã báo cáo đánh giá này.');
      next(error);
    }
  });

  return router;
};
