const path = require('path');
const nunjucks = require('nunjucks');

const env = nunjucks.configure(path.join(__dirname, '..', 'views'), {
  autoescape: true,
  noCache: true
});
env.addFilter('vnd', (value) => Number(value || 0).toLocaleString('vi-VN'));

const base = {
  admin: { id: 1, username: 'admin', full_name: 'Admin EventDecor' },
  active: 'dashboard',
  notice: '',
  stats: {},
  summary: {},
  filters: {},
  statuses: [],
  monthly: [],
  recentOrders: [],
  users: [],
  orders: [],
  partners: [],
  transactions: [],
  reports: [],
  services: [],
  schedules: [],
  scheduleGroups: [],
  availableSchedules: [],
  reviews: [],
  revenueChart: [],
  month: '2026-11',
  newIds: [],
  service: { id: 1, title: 'Dịch vụ', image: '', rating: 0, reviews: 0, price: 0, includes: [] },
  product: { id: 1, title: 'Dịch vụ' },
  related: [],
  lines: [],
  methods: {},
  form: {},
  subtotal: 0,
  fee: 0,
  total: 0
};

for (const file of [
  'index.html',
  'eventservices.html',
  'admin/dashboard.html',
  'admin/users.html',
  'admin/orders.html',
  'admin/finance.html',
  'admin/reports.html',
  'admin/services.html',
  'admin/reviews.html',
  'partner_dashboard.html',
  'orders.html',
  'service_detail.html',
  'cart_checkout.html',
  'partner_order_new.html',
  'report.html'
]) {
  env.render(file, { ...base, user: base.admin, partner: null, success: '', error: null });
  console.log(`OK ${file}`);
}

