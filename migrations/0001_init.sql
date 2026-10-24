-- Veeess Knits schema. Money is always stored in paise (integer).

CREATE TABLE brands (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  tagline TEXT NOT NULL DEFAULT ''
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  fabric TEXT NOT NULL DEFAULT '',
  gsm INTEGER,
  care TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_new INTEGER NOT NULL DEFAULT 0 CHECK (is_new IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Stock rule enforced by the database itself: reserved can never exceed stock.
-- A checkout that would oversell fails the CHECK and the whole batch rolls back.
CREATE TABLE product_variants (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  colour TEXT NOT NULL,
  colour_hex TEXT NOT NULL DEFAULT '#888888',
  size TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  price_paise INTEGER NOT NULL CHECK (price_paise > 0),
  mrp_paise INTEGER CHECK (mrp_paise IS NULL OR mrp_paise >= price_paise),
  stock INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (stock >= 0 AND reserved >= 0 AND reserved <= stock),
  UNIQUE (product_id, colour, size)
);
CREATE INDEX idx_variants_product ON product_variants(product_id);

CREATE TABLE product_images (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  colour TEXT,
  -- '/images/...' for bundled images, 'r2:<key>' for admin uploads
  src TEXT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_images_product ON product_images(product_id);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE addresses (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  line1 TEXT NOT NULL,
  line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  pincode TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,                       -- random UUID, never guessable
  number INTEGER NOT NULL UNIQUE,            -- human number, shown as VK-<number>
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  address_id INTEGER NOT NULL REFERENCES addresses(id),
  status TEXT NOT NULL CHECK (status IN (
    'created','paid','cod_pending','confirmed','packed','shipped',
    'delivered','cancelled','refunded','expired','failed')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('razorpay','cod')),
  subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  shipping_paise INTEGER NOT NULL CHECK (shipping_paise >= 0),
  cod_fee_paise INTEGER NOT NULL DEFAULT 0 CHECK (cod_fee_paise = 0), -- COD is free, by decision
  total_paise INTEGER NOT NULL CHECK (total_paise = subtotal_paise + shipping_paise + cod_fee_paise),
  razorpay_order_id TEXT UNIQUE,
  tracking_number TEXT,
  needs_attention TEXT,
  handled_by TEXT,
  client_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT,
  expires_at TEXT
);
CREATE INDEX idx_orders_status ON orders(status, created_at);
CREATE INDEX idx_orders_customer ON orders(customer_id);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  product_name TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0 AND qty <= 10),
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise > 0),
  UNIQUE (order_id, variant_id)
);
CREATE INDEX idx_items_order ON order_items(order_id);

-- A payment id can only ever be recorded once: makes webhooks idempotent.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  razorpay_payment_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  method TEXT,
  source TEXT NOT NULL CHECK (source IN ('verify','webhook','reconcile')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_payments_order ON payments(order_id);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One alert per order per type; read state is shared by all admins.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT,
  read_by TEXT,
  realerted_at TEXT,
  UNIQUE (type, order_id)
);
CREATE INDEX idx_notifications_unread ON notifications(read_at, id);

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  admin_email TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL DEFAULT '',
  failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_success_at TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
