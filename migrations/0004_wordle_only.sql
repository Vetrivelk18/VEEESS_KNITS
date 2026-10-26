-- Wordle is the only brand (decision 24 Oct 2026). Max8 is retired.
-- 1. Move every product to Wordle and rename "Max8 …" products/slugs/photos.
-- 2. Delete the Max8 brand.
-- 3. Database rule: products can only ever belong to Wordle.
-- Past orders keep the product names they were bought under (order_items is untouched).

UPDATE products
   SET name = 'Wordle ' || substr(name, 6),
       slug = 'wordle-' || substr(slug, 6),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE brand_id = (SELECT id FROM brands WHERE slug = 'max8')
   AND name LIKE 'Max8 %' AND slug LIKE 'max8-%';

UPDATE products
   SET description = replace(description, 'Max8', 'Wordle')
 WHERE description LIKE '%Max8%';

UPDATE product_images
   SET alt = 'Wordle ' || substr(alt, 6)
 WHERE alt LIKE 'Max8 %';

UPDATE products
   SET brand_id = (SELECT id FROM brands WHERE slug = 'wordle')
 WHERE brand_id <> (SELECT id FROM brands WHERE slug = 'wordle');

DELETE FROM brands WHERE slug <> 'wordle';

UPDATE brands
   SET tagline = 'Our own label — T-shirts and everyday knitwear, made and checked in Tiruppur.'
 WHERE slug = 'wordle';

CREATE TRIGGER products_wordle_only_insert
BEFORE INSERT ON products
WHEN NEW.brand_id IS NOT (SELECT id FROM brands WHERE slug = 'wordle')
BEGIN
  SELECT RAISE(ABORT, 'Only Wordle products are allowed');
END;

CREATE TRIGGER products_wordle_only_update
BEFORE UPDATE OF brand_id ON products
WHEN NEW.brand_id IS NOT (SELECT id FROM brands WHERE slug = 'wordle')
BEGIN
  SELECT RAISE(ABORT, 'Only Wordle products are allowed');
END;

CREATE TRIGGER brands_wordle_only
BEFORE INSERT ON brands
BEGIN
  SELECT RAISE(ABORT, 'Wordle is the only brand');
END;
