const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const serviceImageDirectory = path.join(__dirname, '..', 'img', 'uploads', 'services');
fs.mkdirSync(serviceImageDirectory, { recursive: true });

const serviceImageExtensions = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

const serviceImageUpload = multer({
  storage: multer.diskStorage({
    destination: serviceImageDirectory,
    filename: (req, file, callback) => callback(null, `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${serviceImageExtensions[file.mimetype]}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!serviceImageExtensions[file.mimetype]) return callback(new Error('Ảnh phải có định dạng JPG, PNG hoặc WebP.'));
    callback(null, true);
  }
});

const ORDER_STATUSES = ['pending', 'approved', 'accepted', 'surveying', 'setup', 'inspection', 'completed', 'rejected', 'cancelled'];
const REPORT_STATUSES = ['open', 'in_progress', 'resolved', 'rejected'];
const SERVICE_STATUSES = ['pending', 'active', 'inactive', 'rejected'];
const orderStatusLabels = {
  pending: 'Chờ admin duyệt', approved: 'Chờ đối tác chấp nhận', accepted: 'Đã chấp nhận đơn',
  surveying: 'Đang khảo sát mặt bằng', setup: 'Đang setup không gian', inspection: 'Đang nghiệm thu', completed: 'Hoàn thành',
  rejected: 'Từ chối', cancelled: 'Đã hủy'
};
const serviceStatusLabels = {
  pending: 'Chờ duyệt', active: 'Đang hiển thị', inactive: 'Tạm ẩn', rejected: 'Cần chỉnh sửa'
};
const reportStatusLabels = {
  open: 'Mới tiếp nhận', in_progress: 'Đang xử lý', resolved: 'Đã giải quyết', rejected: 'Từ chối'
};
const partnerTransitions = {
  approved: 'accepted', accepted: 'surveying', surveying: 'setup', setup: 'inspection', inspection: 'completed'
};
const money = (value) => `${Number(value || 0).toLocaleString('vi-VN')} ₫`;
const date = (value) => value ? new Date(value).toLocaleDateString('vi-VN') : '—';
const dateTime = (value) => value ? new Date(value).toLocaleString('vi-VN') : '—';

module.exports = function createAdminRoutes({ pool, refreshServices = async () => {} }) {
  const router = express.Router();

  function isAjax(req) {
    return req.get('x-requested-with') === 'XMLHttpRequest';
  }

  function actionSuccess(req, res, message, redirect, data = {}) {
    if (isAjax(req)) return res.json({ ok: true, message, data });
    return res.redirect(`${redirect}${redirect.includes('?') ? '&' : '?'}notice=${encodeURIComponent(message)}`);
  }

  function actionError(req, res, status, message) {
    if (isAjax(req)) return res.status(status).json({ ok: false, message });
    return res.status(status).send(message);
  }

  function uploadServiceImage(req, res, next) {
    serviceImageUpload.single('image_file')(req, res, (error) => {
      if (!error) return next();
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Ảnh dịch vụ không được vượt quá 5 MB.'
        : error.message || 'Không thể tải ảnh dịch vụ.';
      return actionError(req, res, 400, message);
    });
  }

  function serviceImageFromRequest(req, fallback = null) {
    if (req.file) return `/img/uploads/services/${req.file.filename}`;
    return String(req.body.image || '').trim() || fallback || null;
  }

  function removeUploadedFile(file) {
    if (!file || !file.path) return;
    fs.promises.unlink(file.path).catch(() => {});
  }

  function removeLocalServiceImage(image) {
    const prefix = '/img/uploads/services/';
    if (!image || !String(image).startsWith(prefix)) return;
    const filename = path.basename(String(image));
    fs.promises.unlink(path.join(serviceImageDirectory, filename)).catch(() => {});
  }

  function requireRole(role) {
    return (req, res, next) => {
      if (!req.session.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      if (req.session.user.role !== role) return res.status(403).send('Bạn không có quyền truy cập trang này.');
      next();
    };
  }

  async function addProgress(connection, orderId, status, note, user) {
    await connection.query(
      `INSERT INTO order_progress (order_id, status, note, actor_id, actor_role)
       VALUES (?, ?, ?, ?, ?)`,
      [orderId, status, note || null, user.id, user.role]
    );
  }

  const requireAdmin = requireRole('admin');
  const requirePartner = requireRole('partner');
  router.use('/admin', requireAdmin);

  router.get('/admin', async (req, res, next) => {
    try {
      const [[users]] = await pool.query(`
        SELECT COUNT(*) AS total, SUM(role = 'partner') AS partners,
               SUM(status = 'locked') AS locked_count FROM \`user\``);
      const [[orders]] = await pool.query(`
        SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending_count,
               COALESCE(SUM(CASE WHEN status = 'completed' THEN final_amount ELSE 0 END), 0) AS revenue,
               COALESCE(SUM(CASE WHEN status = 'completed' THEN commission_amount ELSE 0 END), 0) AS commission
        FROM orders`);
      const [[reports]] = await pool.query("SELECT COUNT(*) AS total, SUM(status IN ('open','in_progress')) AS open_count FROM reports");
      const [[services]] = await pool.query("SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending_count FROM services");
      const [monthlyRows] = await pool.query(`
        SELECT DATE_FORMAT(MIN(completed_at), '%m/%Y') AS label,
               SUM(final_amount) AS revenue, SUM(commission_amount) AS commission
        FROM orders WHERE status = 'completed' AND completed_at >= DATE_SUB(CURRENT_DATE, INTERVAL 5 MONTH)
        GROUP BY YEAR(completed_at), MONTH(completed_at) ORDER BY YEAR(completed_at), MONTH(completed_at)`);
      const [recentRows] = await pool.query(`
        SELECT o.id, o.customer_name, o.final_amount, o.status, o.created_at,
               COALESCE(p.name, 'Chưa phân công') AS partner_name
        FROM orders o LEFT JOIN partners p ON p.id = o.partner_id
        ORDER BY o.created_at DESC LIMIT 6`);
      const maxRevenue = Math.max(1, ...monthlyRows.map((row) => Number(row.revenue)));
      res.render('admin/dashboard.html', {
        admin: req.session.user, active: 'dashboard', notice: req.query.notice || '',
        stats: {
          users: Number(users.total || 0), partners: Number(users.partners || 0),
          pending_orders: Number(orders.pending_count || 0), open_reports: Number(reports.open_count || 0),
          pending_services: Number(services.pending_count || 0), revenue: money(orders.revenue),
          commission: money(orders.commission)
        },
        monthly: monthlyRows.map((row) => ({ ...row, revenue_text: money(row.revenue), commission_text: money(row.commission), percent: Math.max(4, Math.round(Number(row.revenue) / maxRevenue * 100)) })),
        recentOrders: recentRows.map((row) => ({ ...row, amount_text: money(row.final_amount), status_label: orderStatusLabels[row.status], created_text: dateTime(row.created_at) }))
      });
    } catch (error) { next(error); }
  });

  router.get(['/admin/users', '/admin/manager-customer', '/admin/manager-partner'], async (req, res, next) => {
    const search = String(req.query.search || '').trim();
    const roleFromPath = req.path.endsWith('manager-partner') ? 'partner' : '';
    const role = ['user', 'partner', 'admin'].includes(req.query.role) ? req.query.role : roleFromPath;
    const status = ['active', 'locked'].includes(req.query.status) ? req.query.status : '';
    try {
      const clauses = [];
      const params = [];
      if (search) {
        clauses.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.username LIKE ?)');
        params.push(...Array(4).fill(`%${search}%`));
      }
      if (role) { clauses.push('u.role = ?'); params.push(role); }
      if (status) { clauses.push('u.status = ?'); params.push(status); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const [rows] = await pool.query(`
        SELECT u.id, u.username, u.email, u.full_name, u.phone, u.role, u.status, u.created_at,
               COUNT(DISTINCT o.id) AS order_count,
               COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.final_amount ELSE 0 END), 0) AS total_spent
        FROM \`user\` u LEFT JOIN orders o ON o.user_id = u.id
        ${where} GROUP BY u.id ORDER BY u.created_at DESC`, params);
      const [[summary]] = await pool.query(`
        SELECT COUNT(*) AS total, SUM(status = 'active') AS active_count,
               SUM(status = 'locked') AS locked_count, SUM(role = 'partner') AS partner_count FROM \`user\``);
      res.render('admin/users.html', {
        admin: req.session.user, active: 'users', filters: { search, role, status }, summary,
        users: rows.map((row) => ({ ...row, created_text: date(row.created_at), spent_text: money(row.total_spent), role_label: row.role === 'admin' ? 'Quản trị viên' : row.role === 'partner' ? 'Đối tác' : 'Khách hàng' })),
        notice: req.query.notice || ''
      });
    } catch (error) { next(error); }
  });

  router.post('/admin/users/:id/status', async (req, res, next) => {
    const status = req.body.status;
    if (!['active', 'locked'].includes(status)) return actionError(req, res, 400, 'Trạng thái không hợp lệ.');
    if (Number(req.params.id) === Number(req.session.user.id) && status === 'locked') return actionError(req, res, 400, 'Không thể tự khóa tài khoản đang đăng nhập.');
    try {
      const [result] = await pool.query('UPDATE `user` SET status = ? WHERE id = ?', [status, req.params.id]);
      if (!result.affectedRows) return actionError(req, res, 404, 'Không tìm thấy tài khoản.');
      return actionSuccess(req, res, 'Đã cập nhật trạng thái tài khoản.', '/admin/users', { status });
    } catch (error) { next(error); }
  });

  router.post('/admin/users/:id/role', async (req, res, next) => {
    const role = req.body.role;
    if (!['user', 'partner', 'admin'].includes(role)) return actionError(req, res, 400, 'Vai trò không hợp lệ.');
    if (Number(req.params.id) === Number(req.session.user.id) && role !== 'admin') return actionError(req, res, 400, 'Không thể tự hạ quyền tài khoản đang đăng nhập.');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.query('UPDATE `user` SET role = ? WHERE id = ?', [role, req.params.id]);
      if (!result.affectedRows) throw Object.assign(new Error('Không tìm thấy tài khoản.'), { status: 404 });
      if (role === 'partner') {
        const [[account]] = await connection.query('SELECT full_name, username, email, phone FROM `user` WHERE id = ?', [req.params.id]);
        const [[profile]] = await connection.query('SELECT id FROM partners WHERE user_id = ?', [req.params.id]);
        if (!profile) {
          const [[matching]] = await connection.query('SELECT id FROM partners WHERE email = ? AND user_id IS NULL LIMIT 1', [account.email]);
          if (matching) await connection.query('UPDATE partners SET user_id = ?, status = ? WHERE id = ?', [req.params.id, 'active', matching.id]);
          else await connection.query('INSERT INTO partners (user_id, name, email, phone, description) VALUES (?, ?, ?, ?, ?)',
            [req.params.id, account.full_name || account.username, account.email, account.phone, 'Hồ sơ đối tác được tạo từ trung tâm quản trị.']);
        }
      } else {
        await connection.query('UPDATE partners SET user_id = NULL WHERE user_id = ?', [req.params.id]);
      }
      await connection.commit();
      return actionSuccess(req, res, 'Đã cập nhật vai trò tài khoản.', '/admin/users', { role });
    } catch (error) {
      await connection.rollback();
      if (error.status) return actionError(req, res, error.status, error.message);
      next(error);
    } finally { connection.release(); }
  });

  router.get(['/admin/services', '/admin/approve-event', '/admin/available-event'], async (req, res, next) => {
    const status = SERVICE_STATUSES.includes(req.query.status) ? req.query.status : '';
    try {
      const [services] = await pool.query(`
        SELECT s.*, p.name AS partner_name, p.status AS partner_status
        FROM services s LEFT JOIN partners p ON p.id = s.partner_id
        ${status ? 'WHERE s.status = ?' : ''}
        ORDER BY FIELD(s.status, 'pending','rejected','active','inactive'), s.created_at DESC`, status ? [status] : []);
      const [partners] = await pool.query("SELECT id, name FROM partners WHERE status = 'active' ORDER BY name");
      const [schedules] = await pool.query(`
        SELECT ps.*, p.name AS partner_name FROM partner_schedules ps
        JOIN partners p ON p.id = ps.partner_id
        WHERE ps.work_date >= CURRENT_DATE ORDER BY ps.work_date, ps.start_time LIMIT 100`);
      const [[summary]] = await pool.query(`SELECT COUNT(*) total, SUM(status='pending') pending_count, SUM(status='active') active_count, SUM(status='rejected') rejected_count FROM services`);
      res.render('admin/services.html', {
        admin: req.session.user, active: 'services',
        services: services.map((service) => ({ ...service, status_label: serviceStatusLabels[service.status] || service.status })),
        partners, schedules, summary,
        filters: { status }, statuses: SERVICE_STATUSES.map((value) => ({ value, label: serviceStatusLabels[value] })),
        notice: req.query.notice || ''
      });
    } catch (error) { next(error); }
  });

  router.post('/admin/services/:id/status', async (req, res, next) => {
    const status = req.body.status;
    if (!SERVICE_STATUSES.includes(status)) return actionError(req, res, 400, 'Trạng thái dịch vụ không hợp lệ.');
    const adminNote = String(req.body.admin_note || '').trim();
    if (status === 'rejected' && adminNote.length < 5) {
      return actionError(req, res, 400, 'Vui lòng nhập lý do yêu cầu đối tác chỉnh sửa.');
    }
    try {
      const [result] = await pool.query(`
        UPDATE services SET status = ?, admin_note = ?,
          approved_by = CASE WHEN ? = 'active' THEN ? WHEN ? IN ('pending', 'rejected') THEN NULL ELSE approved_by END,
          approved_at = CASE WHEN ? = 'active' THEN NOW() WHEN ? IN ('pending', 'rejected') THEN NULL ELSE approved_at END
        WHERE id = ?`,
      [status, adminNote || null, status, req.session.user.id, status, status, status, req.params.id]);
      if (!result.affectedRows) return actionError(req, res, 404, 'Không tìm thấy dịch vụ.');
      await refreshServices();
      return actionSuccess(req, res, 'Đã cập nhật kiểm duyệt dịch vụ.', '/admin/services', { status });
    } catch (error) { next(error); }
  });

  router.post('/admin/schedules', async (req, res, next) => {
    const partnerId = Number(req.body.partner_id);
    const workDate = String(req.body.work_date || '');
    const startTime = String(req.body.start_time || '');
    const endTime = String(req.body.end_time || '');
    const status = ['available', 'busy', 'unavailable'].includes(req.body.status) ? req.body.status : 'available';
    if (!partnerId || !workDate || !startTime || !endTime || startTime >= endTime) return actionError(req, res, 400, 'Thông tin lịch làm việc không hợp lệ.');
    try {
      await pool.query(`
        INSERT INTO partner_schedules (partner_id, work_date, start_time, end_time, status, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE end_time=VALUES(end_time), status=VALUES(status), note=VALUES(note), created_by=VALUES(created_by)`,
      [partnerId, workDate, startTime, endTime, status, String(req.body.note || '').trim() || null, req.session.user.id]);
      return actionSuccess(req, res, 'Đã lưu lịch làm việc của đối tác.', '/admin/services');
    } catch (error) { next(error); }
  });

  router.get('/admin/orders', async (req, res, next) => {
    const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : '';
    const search = String(req.query.search || '').trim();
    try {
      const clauses = [];
      const params = [];
      if (status) { clauses.push('o.status = ?'); params.push(status); }
      if (search) { clauses.push('(o.customer_name LIKE ? OR o.service_name LIKE ? OR CAST(o.id AS CHAR) LIKE ?)'); params.push(...Array(3).fill(`%${search}%`)); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const [rows] = await pool.query(`
        SELECT o.*, u.email AS customer_email, COALESCE(p.name, 'Chưa phân công') AS partner_name
        FROM orders o LEFT JOIN \`user\` u ON u.id = o.user_id LEFT JOIN partners p ON p.id = o.partner_id
        ${where}
        ORDER BY FIELD(o.status, 'pending','approved','accepted','surveying','setup','inspection','completed','rejected','cancelled'), o.created_at DESC`, params);
      const [partners] = await pool.query("SELECT id, name FROM partners WHERE status = 'active' ORDER BY name");
      const [[summary]] = await pool.query(`SELECT COUNT(*) total, SUM(status='pending') pending_count, SUM(status='approved') approved_count, SUM(status='completed') completed_count FROM orders`);
      res.render('admin/orders.html', {
        admin: req.session.user, active: 'orders', filters: { status, search }, summary, partners,
        statuses: ORDER_STATUSES.map((value) => ({ value, label: orderStatusLabels[value] })),
        orders: rows.map((row) => ({ ...row, status_label: orderStatusLabels[row.status], amount_text: money(row.final_amount), commission_text: money(row.commission_amount), payout_text: money(row.partner_payout), event_text: date(row.event_date), created_text: dateTime(row.created_at) })),
        notice: req.query.notice || ''
      });
    } catch (error) { next(error); }
  });

  router.post('/admin/orders/:id/status', async (req, res, next) => {
    const status = req.body.status;
    if (!['approved', 'rejected', 'cancelled'].includes(status)) return actionError(req, res, 400, 'Admin chỉ có thể phân công, từ chối hoặc hủy đơn.');
    const partnerId = Number(req.body.partner_id);
    if (status === 'approved' && !partnerId) return actionError(req, res, 400, 'Vui lòng chọn đối tác trước khi duyệt đơn.');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[order]] = await connection.query('SELECT status, schedule_id, partner_id FROM orders WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!order) { await connection.rollback(); return actionError(req, res, 404, 'Không tìm thấy đơn hàng.'); }
      if (!['pending', 'approved'].includes(order.status)) { await connection.rollback(); return actionError(req, res, 409, 'Đơn đã được đối tác tiếp nhận nên admin không thể đổi quyết định trực tiếp.'); }
      if (status === 'approved' && order.schedule_id && Number(order.partner_id) !== partnerId) {
        await connection.rollback();
        return actionError(req, res, 409, 'Khách đã chọn lịch của đối tác hiện tại nên không thể phân công sang đối tác khác.');
      }
      await connection.query(`
        UPDATE orders SET status = ?, partner_id = CASE WHEN ? = 'approved' THEN ? ELSE partner_id END,
          admin_note = ?, approved_by = ?, approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, NOW()) ELSE approved_at END,
          assigned_at = CASE WHEN ? = 'approved' THEN NOW() ELSE assigned_at END
        WHERE id = ?`,
      [status, status, partnerId || null, String(req.body.admin_note || '').trim() || null,
        req.session.user.id, status, status, req.params.id]);
      await addProgress(connection, req.params.id, status, String(req.body.admin_note || '').trim() || (status === 'approved' ? 'Admin đã duyệt và phân công đối tác.' : 'Admin đã cập nhật quyết định.'), req.session.user);
      if (['rejected', 'cancelled'].includes(status) && order.schedule_id) {
        await connection.query("UPDATE partner_schedules SET status='available' WHERE id=? AND status='busy'", [order.schedule_id]);
      }
      await connection.commit();
      return actionSuccess(req, res, `Đã cập nhật đơn hàng #${req.params.id}.`, '/admin/orders', { status });
    } catch (error) {
      await connection.rollback(); next(error);
    } finally { connection.release(); }
  });

  router.get(['/admin/finance', '/admin/financial-payout'], async (req, res, next) => {
    try {
      const [[summary]] = await pool.query(`
        SELECT COALESCE(SUM(CASE WHEN status='completed' THEN final_amount ELSE 0 END),0) gross,
               COALESCE(SUM(CASE WHEN status='completed' THEN partner_payout ELSE 0 END),0) payout,
               COALESCE(SUM(CASE WHEN status='completed' THEN commission_amount ELSE 0 END),0) commission,
               COALESCE(SUM(CASE WHEN status='completed' AND payout_status='paid' THEN partner_payout ELSE 0 END),0) paid,
               COUNT(CASE WHEN status='completed' THEN 1 END) order_count FROM orders`);
      const [partners] = await pool.query(`
        SELECT p.id, p.name, COUNT(o.id) order_count, COALESCE(SUM(o.final_amount),0) gross,
               COALESCE(SUM(o.partner_payout),0) payout, COALESCE(SUM(o.commission_amount),0) commission
        FROM partners p LEFT JOIN orders o ON o.partner_id=p.id AND o.status='completed'
        GROUP BY p.id ORDER BY gross DESC`);
      const [transactions] = await pool.query(`
        SELECT o.id,o.completed_at,o.final_amount,o.commission_amount,o.partner_payout,o.status,o.payout_status,o.paid_at,p.name partner_name
        FROM orders o JOIN partners p ON p.id=o.partner_id WHERE o.status='completed'
        ORDER BY o.completed_at DESC,o.id DESC LIMIT 100`);
      res.render('admin/finance.html', {
        admin: req.session.user, active: 'finance', notice: req.query.notice || '',
        summary: { gross: money(summary.gross), payout: money(summary.payout), commission: money(summary.commission), collected: money(summary.gross), paid: money(summary.paid), order_count: Number(summary.order_count) },
        partners: partners.map((row) => ({ ...row, gross_text: money(row.gross), payout_text: money(row.payout), commission_text: money(row.commission) })),
        transactions: transactions.map((row) => ({ ...row, created_text: dateTime(row.completed_at), gross_text: money(row.final_amount), payout_text: money(row.partner_payout), commission_text: money(row.commission_amount), status_label: row.payout_status === 'paid' ? 'Đã chi trả' : 'Chờ chi trả' }))
      });
    } catch (error) { next(error); }
  });

  router.post('/admin/orders/:id/payout', async (req, res, next) => {
    try {
      const [result] = await pool.query(`UPDATE orders SET payout_status='paid',paid_at=NOW(),paid_by=? WHERE id=? AND status='completed' AND payout_status<>'paid'`, [req.session.user.id, req.params.id]);
      if (!result.affectedRows) return actionError(req, res, 409, 'Đơn chưa hoàn thành, đã chi trả hoặc không tồn tại.');
      return actionSuccess(req, res, `Đã xác nhận chi trả đơn #${req.params.id}.`, '/admin/finance');
    } catch (error) { next(error); }
  });

  router.get('/admin/reports', async (req, res, next) => {
    const status = REPORT_STATUSES.includes(req.query.status) ? req.query.status : '';
    try {
      const [rows] = await pool.query(`SELECT r.*,u.full_name,u.email,u.phone FROM reports r LEFT JOIN \`user\` u ON u.id=r.reporter_id ${status ? 'WHERE r.status=?' : ''} ORDER BY FIELD(r.status,'open','in_progress','resolved','rejected'),r.created_at DESC`, status ? [status] : []);
      const [[summary]] = await pool.query(`SELECT COUNT(*) total,SUM(status='open') open_count,SUM(status='in_progress') processing_count,SUM(status='resolved') resolved_count FROM reports`);
      res.render('admin/reports.html', { admin:req.session.user,active:'reports',filters:{status},summary,statuses:REPORT_STATUSES.map((value)=>({value,label:reportStatusLabels[value]})),reports:rows.map((row)=>({...row,status_label:reportStatusLabels[row.status],created_text:dateTime(row.created_at)})),notice:req.query.notice||'' });
    } catch (error) { next(error); }
  });

  router.post('/admin/reports/:id/resolve', async (req, res, next) => {
    const status=req.body.status;
    if(!REPORT_STATUSES.includes(status)) return actionError(req,res,400,'Trạng thái không hợp lệ.');
    try { const [result]=await pool.query('UPDATE reports SET status=?,admin_response=?,handled_by=? WHERE id=?',[status,String(req.body.admin_response||'').trim()||null,req.session.user.id,req.params.id]); if(!result.affectedRows)return actionError(req,res,404,'Không tìm thấy phản ánh.'); return actionSuccess(req,res,'Đã lưu kết quả xử lý phản ánh.','/admin/reports'); } catch(error){next(error);}
  });

  router.get('/admin/reviews', async (req, res, next) => {
    try {
      const [reviews]=await pool.query(`SELECT r.*,u.full_name,s.title,COUNT(rr.id) report_count FROM reviews r JOIN \`user\` u ON u.id=r.user_id JOIN services s ON s.id=r.service_id LEFT JOIN review_reports rr ON rr.review_id=r.id AND rr.status='open' GROUP BY r.id ORDER BY report_count DESC,r.created_at DESC`);
      const [reports]=await pool.query(`SELECT rr.*,r.comment,r.rating,u.full_name reporter_name,s.title FROM review_reports rr JOIN reviews r ON r.id=rr.review_id JOIN \`user\` u ON u.id=rr.reporter_id JOIN services s ON s.id=r.service_id ORDER BY FIELD(rr.status,'open','resolved','rejected'),rr.created_at DESC`);
      res.render('admin/reviews.html',{admin:req.session.user,active:'reviews',reviews:reviews.map((row)=>({...row,created_text:dateTime(row.created_at)})),reports:reports.map((row)=>({...row,created_text:dateTime(row.created_at)})),notice:req.query.notice||''});
    } catch(error){next(error);}
  });

  router.post('/admin/review-reports/:id/resolve', async (req,res,next)=>{
    const status=['resolved','rejected'].includes(req.body.status)?req.body.status:null;
    if(!status)return actionError(req,res,400,'Quyết định không hợp lệ.');
    const connection=await pool.getConnection();
    try{await connection.beginTransaction();const [[report]]=await connection.query('SELECT rr.review_id,r.service_id FROM review_reports rr JOIN reviews r ON r.id=rr.review_id WHERE rr.id=? FOR UPDATE',[req.params.id]);if(!report){await connection.rollback();return actionError(req,res,404,'Không tìm thấy báo cáo.');}await connection.query('UPDATE review_reports SET status=?,admin_note=?,handled_by=?,resolved_at=NOW() WHERE id=?',[status,String(req.body.admin_note||'').trim()||null,req.session.user.id,req.params.id]);if(status==='resolved'&&req.body.hide_review==='1'){await connection.query("UPDATE reviews SET status='hidden' WHERE id=?",[report.review_id]);await connection.query(`UPDATE services s SET s.rating=(SELECT COALESCE(AVG(r.rating),0) FROM reviews r WHERE r.service_id=s.id AND r.status='published'),s.reviews=(SELECT COUNT(*) FROM reviews r WHERE r.service_id=s.id AND r.status='published') WHERE s.id=?`,[report.service_id]);}await connection.commit();return actionSuccess(req,res,'Đã xử lý báo cáo đánh giá.','/admin/reviews');}catch(error){await connection.rollback();next(error);}finally{connection.release();}
  });

  router.get('/partner/dashboard', requirePartner, async (req, res, next) => {
    try {
      const [[partner]] = await pool.query('SELECT * FROM partners WHERE user_id=? LIMIT 1', [req.session.user.id]);
      if (!partner) return res.status(409).send('Tài khoản chưa được liên kết với hồ sơ đối tác.');
      const currentMonth = new Date().toISOString().slice(0, 7);
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : currentMonth;
      const [services] = await pool.query('SELECT * FROM services WHERE partner_id=? ORDER BY created_at DESC', [partner.id]);
      const [orders] = await pool.query(`
        SELECT o.*,u.email customer_email
        FROM orders o LEFT JOIN \`user\` u ON u.id=o.user_id
        WHERE o.partner_id=?
        ORDER BY FIELD(o.status,'approved','accepted','surveying','setup','inspection','pending','completed','rejected','cancelled'),o.event_date,o.id DESC`, [partner.id]);
      const [schedules] = await pool.query(`
        SELECT *,DATE_FORMAT(work_date,'%Y-%m-%d') work_date_value FROM partner_schedules
        WHERE partner_id=? AND DATE_FORMAT(work_date,'%Y-%m')=?
        ORDER BY work_date,start_time`, [partner.id, month]);
      const [[summary]] = await pool.query(`
        SELECT COUNT(*) total,
               SUM(status IN ('approved','accepted','surveying','setup','inspection')) active_count,
               SUM(status='completed') completed_count,
               COALESCE(SUM(CASE WHEN status='completed' THEN partner_payout ELSE 0 END),0) revenue,
               COALESCE(SUM(CASE WHEN status='completed' AND payout_status='paid' THEN partner_payout ELSE 0 END),0) paid,
               COALESCE(SUM(CASE WHEN status='completed' AND payout_status<>'paid' THEN partner_payout ELSE 0 END),0) unpaid
        FROM orders WHERE partner_id=?`, [partner.id]);
      const [monthlyRevenue] = await pool.query(`
        SELECT DATE_FORMAT(MIN(completed_at),'%m/%Y') label, SUM(partner_payout) amount
        FROM orders WHERE partner_id=? AND status='completed'
          AND completed_at>=DATE_SUB(CURRENT_DATE,INTERVAL 11 MONTH)
        GROUP BY YEAR(completed_at),MONTH(completed_at)
        ORDER BY YEAR(completed_at),MONTH(completed_at)`, [partner.id]);
      const maxRevenue = Math.max(1, ...monthlyRevenue.map((row) => Number(row.amount)));
      const [reviews] = await pool.query(`
        SELECT r.*,u.full_name,s.title
        FROM reviews r JOIN services s ON s.id=r.service_id JOIN \`user\` u ON u.id=r.user_id
        WHERE s.partner_id=? ORDER BY r.created_at DESC LIMIT 50`, [partner.id]);
      const [transactions] = await pool.query(`
        SELECT id,service_name,completed_at,partner_payout,payout_status,paid_at
        FROM orders WHERE partner_id=? AND status='completed'
        ORDER BY completed_at DESC,id DESC LIMIT 50`, [partner.id]);
      res.render('partner_dashboard.html', {
        user:req.session.user, partner, month,
        services:services.map((row)=>({...row,status_label:serviceStatusLabels[row.status]})),
        orders:orders.map((row)=>({...row,status_label:orderStatusLabels[row.status],amount_text:money(row.final_amount),payout_text:money(row.partner_payout),event_text:date(row.event_date),next_status:partnerTransitions[row.status]||null,next_label:orderStatusLabels[partnerTransitions[row.status]]||null})),
        schedules,
        reviews:reviews.map((row)=>({...row,created_text:dateTime(row.created_at)})),
        transactions:transactions.map((row)=>({...row,payout_text:money(row.partner_payout),completed_text:dateTime(row.completed_at),paid_text:dateTime(row.paid_at)})),
        revenueChart:monthlyRevenue.map((row)=>({...row,amount_text:money(row.amount),percent:Math.max(5,Math.round(Number(row.amount)/maxRevenue*100))})),
        summary:{...summary,revenue_text:money(summary.revenue),paid_text:money(summary.paid),unpaid_text:money(summary.unpaid)},
        notice:req.query.notice||'',error:null
      });
    } catch(error){next(error);}
  });

  router.post('/partner/profile', requirePartner, async (req, res, next) => {
    const name=String(req.body.name||'').trim();
    if(name.length<2)return actionError(req,res,400,'Tên đối tác không hợp lệ.');
    try{const [result]=await pool.query(`UPDATE partners SET name=?,image=?,description=?,address=?,phone=?,email=? WHERE user_id=?`,[name,String(req.body.image||'').trim()||null,String(req.body.description||'').trim()||null,String(req.body.address||'').trim()||null,String(req.body.phone||'').trim()||null,String(req.body.email||'').trim()||null,req.session.user.id]);if(!result.affectedRows)return actionError(req,res,404,'Không tìm thấy hồ sơ đối tác.');return actionSuccess(req,res,'Đã cập nhật thông tin đối tác.','/partner/dashboard');}catch(error){next(error);}
  });

  router.post('/partner/schedules', requirePartner, async (req,res,next)=>{
    const workDate=String(req.body.work_date||'');const start=String(req.body.start_time||'');const end=String(req.body.end_time||'');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(workDate)||!start||!end||start>=end||new Date(`${workDate}T23:59:59`)<new Date())return actionError(req,res,400,'Ngày hoặc khung giờ không hợp lệ.');
    try{const [[partner]]=await pool.query('SELECT id FROM partners WHERE user_id=?',[req.session.user.id]);await pool.query(`INSERT INTO partner_schedules(partner_id,work_date,start_time,end_time,status,note,created_by)VALUES(?,?,?,?,'available',?,?) ON DUPLICATE KEY UPDATE end_time=VALUES(end_time),status='available',note=VALUES(note)`,[partner.id,workDate,start,end,String(req.body.note||'').trim()||null,req.session.user.id]);return actionSuccess(req,res,'Đã lưu lịch rảnh.','/partner/dashboard?month='+workDate.slice(0,7));}catch(error){next(error);}
  });

  router.post('/partner/schedules/:id', requirePartner, async(req,res,next)=>{
    const workDate=String(req.body.work_date||'');const start=String(req.body.start_time||'');const end=String(req.body.end_time||'');const status=['available','unavailable'].includes(req.body.status)?req.body.status:'available';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(workDate)||!start||!end||start>=end)return actionError(req,res,400,'Ngày hoặc khung giờ không hợp lệ.');
    try{const [result]=await pool.query(`UPDATE partner_schedules ps JOIN partners p ON p.id=ps.partner_id SET ps.work_date=?,ps.start_time=?,ps.end_time=?,ps.status=?,ps.note=? WHERE ps.id=? AND p.user_id=? AND ps.status<>'busy'`,[workDate,start,end,status,String(req.body.note||'').trim()||null,req.params.id,req.session.user.id]);if(!result.affectedRows)return actionError(req,res,409,'Lịch đã có đơn đặt hoặc không thuộc đối tác.');return actionSuccess(req,res,'Đã cập nhật lịch.','/partner/dashboard?month='+workDate.slice(0,7));}catch(error){next(error);}
  });

  router.post('/partner/schedules/:id/delete', requirePartner, async(req,res,next)=>{
    try{const [result]=await pool.query(`DELETE ps FROM partner_schedules ps JOIN partners p ON p.id=ps.partner_id WHERE ps.id=? AND p.user_id=? AND ps.status<>'busy'`,[req.params.id,req.session.user.id]);if(!result.affectedRows)return actionError(req,res,409,'Không thể xóa lịch đã có khách đặt.');return actionSuccess(req,res,'Đã xóa lịch rảnh.','/partner/dashboard');}catch(error){next(error);}
  });

  router.post('/partner/services', requirePartner, uploadServiceImage, async(req,res,next)=>{
    try{const [[partner]]=await pool.query('SELECT id FROM partners WHERE user_id=? AND status=?',[req.session.user.id,'active']);if(!partner){removeUploadedFile(req.file);return actionError(req,res,409,'Hồ sơ đối tác chưa hoạt động.');}const title=String(req.body.title||'').trim();const price=Number(req.body.price);const image=serviceImageFromRequest(req);if(title.length<3||!Number.isFinite(price)||price<=0){removeUploadedFile(req.file);return actionError(req,res,400,'Tên và giá dịch vụ không hợp lệ.');}if(!image){removeUploadedFile(req.file);return actionError(req,res,400,'Vui lòng chọn ảnh dịch vụ hoặc nhập đường dẫn ảnh.');}if(image.length>255){removeUploadedFile(req.file);return actionError(req,res,400,'Đường dẫn ảnh không được vượt quá 255 ký tự.');}await pool.query(`INSERT INTO services(partner_id,title,image,price,category,short_desc,duration,area,includes,description,status) VALUES(?,?,?,?,?,?,?,?,?,?,'pending')`,[partner.id,title,image,price,String(req.body.category||'').trim()||null,String(req.body.short_desc||'').trim()||null,String(req.body.duration||'').trim()||null,String(req.body.area||'').trim()||null,String(req.body.includes||'').trim()||null,String(req.body.description||'').trim()||null]);return actionSuccess(req,res,'Đã tải ảnh và gửi dịch vụ mới để admin kiểm duyệt.','/partner/dashboard');}catch(error){removeUploadedFile(req.file);next(error);}
  });

  router.post('/partner/services/:id', requirePartner, uploadServiceImage, async(req,res,next)=>{
    try{const [[current]]=await pool.query(`SELECT s.image FROM services s JOIN partners p ON p.id=s.partner_id WHERE s.id=? AND p.user_id=?`,[req.params.id,req.session.user.id]);if(!current){removeUploadedFile(req.file);return actionError(req,res,404,'Không tìm thấy dịch vụ thuộc đối tác.');}const title=String(req.body.title||'').trim();const price=Number(req.body.price);const image=serviceImageFromRequest(req,current.image);if(title.length<3||!Number.isFinite(price)||price<=0){removeUploadedFile(req.file);return actionError(req,res,400,'Tên và giá dịch vụ không hợp lệ.');}if(image&&image.length>255){removeUploadedFile(req.file);return actionError(req,res,400,'Đường dẫn ảnh không được vượt quá 255 ký tự.');}const [result]=await pool.query(`UPDATE services s JOIN partners p ON p.id=s.partner_id SET s.title=?,s.image=?,s.price=?,s.category=?,s.short_desc=?,s.duration=?,s.area=?,s.includes=?,s.description=?,s.status='pending',s.admin_note=NULL WHERE s.id=? AND p.user_id=?`,[title,image,price,String(req.body.category||'').trim()||null,String(req.body.short_desc||'').trim()||null,String(req.body.duration||'').trim()||null,String(req.body.area||'').trim()||null,String(req.body.includes||'').trim()||null,String(req.body.description||'').trim()||null,req.params.id,req.session.user.id]);if(!result.affectedRows){removeUploadedFile(req.file);return actionError(req,res,404,'Không tìm thấy dịch vụ thuộc đối tác.');}if(req.file&&current.image!==image)removeLocalServiceImage(current.image);return actionSuccess(req,res,'Đã cập nhật ảnh và gửi lại dịch vụ để duyệt.','/partner/dashboard');}catch(error){removeUploadedFile(req.file);next(error);}
  });

  router.post('/partner/services/:id/toggle', requirePartner, async(req,res,next)=>{
    try{const [result]=await pool.query(`UPDATE services s JOIN partners p ON p.id=s.partner_id SET s.status=CASE WHEN s.status='active' THEN 'inactive' ELSE 'active' END WHERE s.id=? AND p.user_id=? AND s.status IN ('active','inactive')`,[req.params.id,req.session.user.id]);if(!result.affectedRows)return actionError(req,res,409,'Chỉ dịch vụ đã được duyệt mới có thể bật hoặc tạm ẩn.');await refreshServices();return actionSuccess(req,res,'Đã cập nhật trạng thái hiển thị dịch vụ.','/partner/dashboard');}catch(error){next(error);}
  });

  router.post('/partner/services/:id/delete', requirePartner, async(req,res,next)=>{
    const connection=await pool.getConnection();
    try{await connection.beginTransaction();const [[service]]=await connection.query(`SELECT s.id,s.image,(SELECT COUNT(*) FROM order_items oi WHERE oi.service_id=s.id) order_count FROM services s JOIN partners p ON p.id=s.partner_id WHERE s.id=? AND p.user_id=? FOR UPDATE`,[req.params.id,req.session.user.id]);if(!service){await connection.rollback();return actionError(req,res,404,'Không tìm thấy dịch vụ.');}if(Number(service.order_count)>0){await connection.query("UPDATE services SET status='inactive' WHERE id=?",[service.id]);await connection.commit();await refreshServices();return actionSuccess(req,res,'Dịch vụ đã có đơn nên được chuyển sang tạm ẩn để bảo toàn lịch sử.','/partner/dashboard');}await connection.query('DELETE FROM services WHERE id=?',[service.id]);await connection.commit();removeLocalServiceImage(service.image);await refreshServices();return actionSuccess(req,res,'Đã xóa dịch vụ.','/partner/dashboard');}catch(error){await connection.rollback();next(error);}finally{connection.release();}
  });

  router.post('/partner/reviews/:id/reply', requirePartner, async(req,res,next)=>{
    const reply=String(req.body.partner_reply||'').trim();if(reply.length<2)return actionError(req,res,400,'Vui lòng nhập nội dung phản hồi.');
    try{const [result]=await pool.query(`UPDATE reviews r JOIN services s ON s.id=r.service_id JOIN partners p ON p.id=s.partner_id SET r.partner_reply=?,r.replied_at=NOW() WHERE r.id=? AND p.user_id=?`,[reply,req.params.id,req.session.user.id]);if(!result.affectedRows)return actionError(req,res,404,'Không tìm thấy đánh giá thuộc dịch vụ của bạn.');return actionSuccess(req,res,'Đã phản hồi đánh giá.','/partner/dashboard#reviews');}catch(error){next(error);}
  });

  router.post('/partner/orders/:id/status', requirePartner, async(req,res,next)=>{
    const connection=await pool.getConnection();
    try{await connection.beginTransaction();const [[order]]=await connection.query(`SELECT o.status FROM orders o JOIN partners p ON p.id=o.partner_id WHERE o.id=? AND p.user_id=? FOR UPDATE`,[req.params.id,req.session.user.id]);if(!order){await connection.rollback();return actionError(req,res,404,'Không tìm thấy đơn thuộc đối tác.');}const nextStatus=partnerTransitions[order.status];if(!nextStatus||req.body.status!==nextStatus){await connection.rollback();return actionError(req,res,409,'Trạng thái đơn phải được cập nhật đúng thứ tự.');}const timestampColumn={accepted:'accepted_at',surveying:'surveying_at',setup:'setup_at',inspection:'inspection_at',completed:'completed_at'}[nextStatus];await connection.query(`UPDATE orders SET status=?,partner_note=?,${timestampColumn}=NOW() WHERE id=?`,[nextStatus,String(req.body.partner_note||'').trim()||null,req.params.id]);await addProgress(connection,req.params.id,nextStatus,String(req.body.partner_note||'').trim()||`Đối tác cập nhật: ${orderStatusLabels[nextStatus]}.`,req.session.user);await connection.commit();return actionSuccess(req,res,`Đã chuyển đơn #${req.params.id} sang “${orderStatusLabels[nextStatus]}”.`,'/partner/dashboard');}catch(error){await connection.rollback();next(error);}finally{connection.release();}
  });

  router.post('/partner/orders/:id/reject', requirePartner, async(req,res,next)=>{
    const reason=String(req.body.reason||'').trim();if(reason.length<5)return actionError(req,res,400,'Vui lòng nhập lý do từ chối rõ ràng.');const connection=await pool.getConnection();
    try{await connection.beginTransaction();const [[order]]=await connection.query(`SELECT o.schedule_id FROM orders o JOIN partners p ON p.id=o.partner_id WHERE o.id=? AND p.user_id=? AND o.status='approved' FOR UPDATE`,[req.params.id,req.session.user.id]);if(!order){await connection.rollback();return actionError(req,res,409,'Chỉ có thể từ chối đơn đang chờ đối tác chấp nhận.');}await connection.query("UPDATE orders SET status='rejected',partner_note=? WHERE id=?",[reason,req.params.id]);if(order.schedule_id)await connection.query("UPDATE partner_schedules SET status='available' WHERE id=? AND status='busy'",[order.schedule_id]);await addProgress(connection,req.params.id,'rejected',`Đối tác từ chối: ${reason}`,req.session.user);await connection.commit();return actionSuccess(req,res,'Đã từ chối đơn và mở lại lịch rảnh.','/partner/dashboard');}catch(error){await connection.rollback();next(error);}finally{connection.release();}
  });

  router.get('/partner/orders/new', requirePartner, (req,res)=>res.redirect('/partner/dashboard#new-order'));
  router.post('/partner/orders', requirePartner, async(req,res,next)=>{
    try{const [[partner]]=await pool.query('SELECT id FROM partners WHERE user_id=?',[req.session.user.id]);if(!partner)return actionError(req,res,409,'Tài khoản chưa có hồ sơ đối tác.');const customerName=String(req.body.customer_name||'').trim();const serviceName=String(req.body.service_name||'').trim();const amount=Number(req.body.final_amount);if(!customerName||!serviceName||!Number.isFinite(amount)||amount<=0)return actionError(req,res,400,'Thông tin đơn không hợp lệ.');const commission=Math.round(amount*.1);const [result]=await pool.query(`INSERT INTO orders(partner_id,source_role,customer_name,customer_phone,service_name,event_date,event_location,note,total_amount,final_amount,payment_method,status,commission_rate,commission_amount,partner_payout) VALUES(?,'partner',?,?,?,?,?,?,?,?,?,'pending',10,?,?)`,[partner.id,customerName,String(req.body.customer_phone||'').trim()||null,serviceName,req.body.event_date||null,String(req.body.event_location||'').trim()||null,String(req.body.note||'').trim()||null,amount,amount,String(req.body.payment_method||'Chuyển khoản'),commission,amount-commission]);await pool.query(`INSERT INTO order_progress(order_id,status,note,actor_id,actor_role)VALUES(?,'pending',?,?, 'partner')`,[result.insertId,'Đối tác tạo đơn và gửi admin duyệt.',req.session.user.id]);return actionSuccess(req,res,`Đã gửi đơn #${result.insertId} để admin duyệt.`,'/partner/dashboard');}catch(error){next(error);}
  });

  return router;
};
