-- Each order keeps the name and email given at checkout, so a later checkout
-- with the same phone number can't change how earlier orders look.
ALTER TABLE orders ADD COLUMN contact_name TEXT;
ALTER TABLE orders ADD COLUMN contact_email TEXT;
UPDATE orders SET contact_name = (SELECT name FROM customers WHERE id = orders.customer_id),
                  contact_email = (SELECT email FROM customers WHERE id = orders.customer_id)
 WHERE contact_name IS NULL;
