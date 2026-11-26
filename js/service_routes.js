const express = require("express");
const router = express.Router();
let databasePool = null;

// Danh sách dịch vụ đã duyệt. Được nạp từ bảng `services` bởi app.js.
const PRODUCTS = [];

function getProduct(id) {
  return PRODUCTS.find((p) => Number(p.id) === id);
}

// GET /services/:id  và  /products/:id
router.get(["/services/:id", "/products/:id"], async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const product = getProduct(id);

  if (!product) {
    return res.status(404).send("Không tìm thấy sản phẩm");
  }

  try {
    const related = PRODUCTS.filter((p) => p.id !== id).slice(0, 3);
    let reviews = [];
    let availableSchedules = [];
    if (databasePool) {
      [reviews] = await databasePool.query(
        `SELECT r.id, r.rating, r.comment, r.partner_reply, r.replied_at, r.created_at, u.full_name
         FROM reviews r JOIN \`user\` u ON u.id = r.user_id
         WHERE r.service_id = ? AND r.status = 'published'
         ORDER BY r.created_at DESC LIMIT 30`,
        [id]
      );
      [availableSchedules] = await databasePool.query(
        `SELECT work_date,start_time,end_time
         FROM partner_schedules
         WHERE partner_id=? AND status='available' AND work_date>=CURRENT_DATE
         ORDER BY work_date,start_time LIMIT 8`,
        [product.partner_id]
      );
    }
    res.render("service_detail.html", {
      product,
      service: product,
      related,
      reviews,
      availableSchedules,
      user: req.session.user || null
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.PRODUCTS = PRODUCTS;
module.exports.SERVICES = PRODUCTS; // bí danh tương thích code cũ
module.exports.setPool = (pool) => { databasePool = pool; };
