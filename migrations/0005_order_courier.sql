-- Which courier carries a shipped order (see shared/couriers.ts), and when the
-- "your order has shipped" email was sent (so it is never sent twice).
ALTER TABLE orders ADD COLUMN courier TEXT
  CHECK (courier IS NULL OR courier IN ('dtdc','delhivery','stcourier','indiapost','professional','other'));
ALTER TABLE orders ADD COLUMN shipped_email_at TEXT;
