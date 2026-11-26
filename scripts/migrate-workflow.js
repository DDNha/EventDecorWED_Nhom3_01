require('dotenv').config();

const mysql = require('mysql2/promise');
const { getDbConfig } = require('../js/db_config');

async function hasColumn(connection, table, column) {
  const [[row]] = await connection.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(row.count) > 0;
}

async function addColumn(connection, table, column, definition) {
  if (!(await hasColumn(connection, table, column))) {
    await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`+ ${table}.${column}`);
  }
}

async function main() {
  const connection = await mysql.createConnection(getDbConfig({ multipleStatements: true }));
  try {
    await connection.query(`
      ALTER TABLE services MODIFY COLUMN status
        ENUM('pending','active','inactive','rejected') NOT NULL DEFAULT 'pending';
    `);

    await addColumn(connection, 'services', 'admin_note', 'TEXT NULL');
    await addColumn(connection, 'services', 'approved_by', 'INT UNSIGNED NULL');
    await addColumn(connection, 'services', 'approved_at', 'DATETIME NULL');
    await addColumn(connection, 'services', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await addColumn(connection, 'orders', 'assigned_at', 'DATETIME NULL');
    await addColumn(connection, 'orders', 'confirmed_at', 'DATETIME NULL');
    await addColumn(connection, 'orders', 'preparing_at', 'DATETIME NULL');
    await addColumn(connection, 'orders', 'processing_at', 'DATETIME NULL');
    await addColumn(connection, 'orders', 'completed_at', 'DATETIME NULL');
    await addColumn(connection, 'orders', 'partner_note', 'TEXT NULL');
    await addColumn(connection, 'orders', 'payout_status', "ENUM('unpaid','pending','paid') NOT NULL DEFAULT 'unpaid'");
    await addColumn(connection, 'orders', 'paid_at', 'DATETIME NULL');
    await addColumn(connection, 'orders', 'paid_by', 'INT UNSIGNED NULL');
    await addColumn(connection, 'orders', 'schedule_id', 'INT UNSIGNED NULL');
    await addColumn(connection, 'orders', 'accepted_at', 'DATETIME NULL');
    await addColumn(connection, 'orders', 'surveying_at', 'DATETIME NULL');
    await addColumn(connection, 'orders', 'setup_at', 'DATETIME NULL');
    await addColumn(connection, 'orders', 'inspection_at', 'DATETIME NULL');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS partner_schedules (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        partner_id INT UNSIGNED NOT NULL,
        work_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        status ENUM('available','busy','unavailable') NOT NULL DEFAULT 'available',
        note VARCHAR(255) NULL,
        created_by INT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_partner_schedule (partner_id, work_date, start_time),
        KEY idx_schedule_partner_date (partner_id, work_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS order_progress (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id INT UNSIGNED NOT NULL,
        status ENUM('pending','approved','accepted','surveying','setup','inspection','completed','rejected','cancelled') NOT NULL,
        note TEXT NULL,
        actor_id INT UNSIGNED NULL,
        actor_role ENUM('user','partner','admin','system') NOT NULL DEFAULT 'system',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_progress_order (order_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS reviews (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id INT UNSIGNED NOT NULL,
        service_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        rating TINYINT UNSIGNED NOT NULL,
        comment TEXT NULL,
        partner_reply TEXT NULL,
        replied_at DATETIME NULL,
        status ENUM('published','hidden') NOT NULL DEFAULT 'published',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_review_order (order_id),
        KEY idx_review_service (service_id, status),
        KEY idx_review_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS review_reports (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        review_id INT UNSIGNED NOT NULL,
        reporter_id INT UNSIGNED NOT NULL,
        reason VARCHAR(255) NOT NULL,
        status ENUM('open','resolved','rejected') NOT NULL DEFAULT 'open',
        admin_note TEXT NULL,
        handled_by INT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME NULL,
        UNIQUE KEY uq_review_reporter (review_id, reporter_id),
        KEY idx_review_report_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await addColumn(connection, 'reviews', 'partner_reply', 'TEXT NULL');
    await addColumn(connection, 'reviews', 'replied_at', 'DATETIME NULL');

    // Mở rộng enum tạm thời để chuyển dữ liệu từ workflow cũ sang workflow đúng nghiệp vụ.
    await connection.query(`
      ALTER TABLE orders MODIFY COLUMN status
        ENUM('pending','approved','confirmed','preparing','processing','accepted','surveying','setup','inspection','completed','rejected','cancelled')
        NOT NULL DEFAULT 'pending';
      ALTER TABLE order_progress MODIFY COLUMN status
        ENUM('pending','approved','confirmed','preparing','processing','accepted','surveying','setup','inspection','completed','rejected','cancelled') NOT NULL;
      UPDATE orders SET status = 'accepted', accepted_at = COALESCE(accepted_at, confirmed_at) WHERE status = 'confirmed';
      UPDATE orders SET status = 'surveying', surveying_at = COALESCE(surveying_at, preparing_at) WHERE status = 'preparing';
      UPDATE orders SET status = 'setup', setup_at = COALESCE(setup_at, processing_at) WHERE status = 'processing';
      UPDATE order_progress SET status = 'accepted' WHERE status = 'confirmed';
      UPDATE order_progress SET status = 'surveying' WHERE status = 'preparing';
      UPDATE order_progress SET status = 'setup' WHERE status = 'processing';
      ALTER TABLE orders MODIFY COLUMN status
        ENUM('pending','approved','accepted','surveying','setup','inspection','completed','rejected','cancelled')
        NOT NULL DEFAULT 'pending';
      ALTER TABLE order_progress MODIFY COLUMN status
        ENUM('pending','approved','accepted','surveying','setup','inspection','completed','rejected','cancelled') NOT NULL;
    `);

    console.log('Workflow schema đã sẵn sàng.');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('Không thể migrate workflow:', error.sqlMessage || error.message);
  process.exitCode = 1;
});
