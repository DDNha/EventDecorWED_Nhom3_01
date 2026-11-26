SET NAMES utf8mb4;
SET time_zone = '+07:00';

CREATE TABLE IF NOT EXISTS `user` (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  email VARCHAR(160) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  phone VARCHAR(30) NULL,
  role ENUM('user','partner','admin') NOT NULL DEFAULT 'user',
  status ENUM('active','locked') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_user_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS partners (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  image VARCHAR(255) NULL,
  description TEXT NULL,
  address VARCHAR(255) NULL,
  phone VARCHAR(30) NULL,
  email VARCHAR(160) NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_partner_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  partner_id INT UNSIGNED NULL,
  title VARCHAR(200) NOT NULL,
  image VARCHAR(255) NULL,
  rating DECIMAL(3,2) NOT NULL DEFAULT 0,
  reviews INT UNSIGNED NOT NULL DEFAULT 0,
  price DECIMAL(15,2) NOT NULL DEFAULT 0,
  category VARCHAR(100) NULL,
  short_desc VARCHAR(500) NULL,
  duration VARCHAR(100) NULL,
  area VARCHAR(160) NULL,
  includes TEXT NULL,
  description TEXT NULL,
  status ENUM('pending','active','inactive','rejected') NOT NULL DEFAULT 'pending',
  admin_note TEXT NULL,
  approved_by INT UNSIGNED NULL,
  approved_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_service_partner (partner_id),
  KEY idx_service_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  partner_id INT UNSIGNED NULL,
  source_role ENUM('customer','partner') NOT NULL DEFAULT 'customer',
  customer_name VARCHAR(160) NOT NULL,
  customer_phone VARCHAR(30) NULL,
  service_name VARCHAR(200) NULL,
  event_date DATE NULL,
  event_time TIME NULL,
  event_location VARCHAR(255) NULL,
  note TEXT NULL,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  final_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  payment_method VARCHAR(100) NULL,
  status ENUM('pending','approved','accepted','surveying','setup','inspection','completed','rejected','cancelled') NOT NULL DEFAULT 'pending',
  commission_rate DECIMAL(5,2) NOT NULL DEFAULT 10,
  commission_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  partner_payout DECIMAL(15,2) NOT NULL DEFAULT 0,
  admin_note TEXT NULL,
  partner_note TEXT NULL,
  approved_by INT UNSIGNED NULL,
  approved_at DATETIME NULL,
  assigned_at DATETIME NULL,
  schedule_id INT UNSIGNED NULL,
  accepted_at DATETIME NULL,
  surveying_at DATETIME NULL,
  setup_at DATETIME NULL,
  inspection_at DATETIME NULL,
  confirmed_at DATETIME NULL,
  preparing_at DATETIME NULL,
  processing_at DATETIME NULL,
  completed_at DATETIME NULL,
  payout_status ENUM('unpaid','pending','paid') NOT NULL DEFAULT 'unpaid',
  paid_at DATETIME NULL,
  paid_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_order_user (user_id),
  KEY idx_order_partner (partner_id),
  KEY idx_order_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  service_id INT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  price DECIMAL(15,2) NOT NULL,
  KEY idx_item_order (order_id),
  KEY idx_item_service (service_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  UNIQUE KEY uq_partner_schedule (partner_id, work_date, start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_progress (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  status ENUM('pending','approved','accepted','surveying','setup','inspection','completed','rejected','cancelled') NOT NULL,
  note TEXT NULL,
  actor_id INT UNSIGNED NULL,
  actor_role ENUM('user','partner','admin','system') NOT NULL DEFAULT 'system',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_progress_order (order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reviews (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL UNIQUE,
  service_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  rating TINYINT UNSIGNED NOT NULL,
  comment TEXT NULL,
  partner_reply TEXT NULL,
  replied_at DATETIME NULL,
  status ENUM('published','hidden') NOT NULL DEFAULT 'published',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_review_service (service_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  UNIQUE KEY uq_review_reporter (review_id, reporter_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reports (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reporter_id INT UNSIGNED NULL,
  reporter_role ENUM('user','partner') NOT NULL DEFAULT 'user',
  order_id INT UNSIGNED NULL,
  subject VARCHAR(180) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'Khác',
  content TEXT NOT NULL,
  priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status ENUM('open','in_progress','resolved','rejected') NOT NULL DEFAULT 'open',
  admin_response TEXT NULL,
  handled_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_report_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO partners (name, image, description, address, phone, email, status)
SELECT seed.name, seed.image, seed.description, seed.address, seed.phone, seed.email, 'active'
FROM (
  SELECT 'Á Châu Event' name, '/img/partners/achauevent.png' image, 'Trang trí sự kiện trọn gói.' description, 'TP. Hồ Chí Minh' address, '0934567890' phone, 'contact@achauevent.vn' email
  UNION ALL SELECT 'Party Design', '/img/partners/partydesn.png', 'Thiết kế tiệc cưới và sinh nhật.', 'TP. Hồ Chí Minh', '0956789012', 'hello@partydesign.vn'
  UNION ALL SELECT 'King Media', '/img/kingMedia.png', 'Quay phim và truyền thông sự kiện.', 'TP. Hồ Chí Minh', '0978901234', 'hello@kingmedia.vn'
) seed
WHERE NOT EXISTS (SELECT 1 FROM partners LIMIT 1);

INSERT INTO services (partner_id, title, image, rating, reviews, price, category, short_desc, duration, area, includes, description, status)
SELECT p.id, seed.title, seed.image, seed.rating, 0, seed.price, seed.category, seed.short_desc,
       seed.duration, 'TP. Hồ Chí Minh', seed.includes, seed.description, 'active'
FROM (
  SELECT 'contact@achauevent.vn' email, 'Trang trí tiệc cưới trọn gói' title, '/img/wedding.png' image, 4.8 rating, 25000000 price, 'Tiệc cưới' category, 'Không gian cưới đồng bộ theo chủ đề.' short_desc, '2-3 ngày' duration, 'Backdrop\nHoa trang trí\nBàn gallery' includes, 'Thiết kế và thi công không gian cưới trọn gói.' description
  UNION ALL SELECT 'hello@partydesign.vn', 'Trang trí sinh nhật', '/img/birthday.png', 4.7, 8500000, 'Sinh nhật', 'Gói sinh nhật theo chủ đề.', '1 ngày', 'Backdrop\nBóng bay\nBàn bánh', 'Trang trí sinh nhật cho gia đình và doanh nghiệp.'
  UNION ALL SELECT 'hello@kingmedia.vn', 'Quay phim sự kiện', '/img/quayPhim.png', 4.9, 12000000, 'Media', 'Ghi hình và dựng video sự kiện.', '1-3 ngày', 'Quay phim\nDựng highlight\nBàn giao dữ liệu', 'Đội ngũ quay phim chuyên nghiệp.'
) seed
JOIN partners p ON p.email = seed.email
WHERE NOT EXISTS (SELECT 1 FROM services LIMIT 1);
