-- Size-chart library (one chart image can be used by many products) and
-- who a product is for (Men / Women / Unisex / Kids). Decision D39.

CREATE TABLE size_charts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 2 AND 80),
  src TEXT NOT NULL,                 -- '/images/…' (built in) or 'r2:size-charts/…' (uploaded)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

ALTER TABLE products ADD COLUMN audience TEXT NOT NULL DEFAULT 'unisex'
  CHECK (audience IN ('men','women','unisex','kids'));
ALTER TABLE products ADD COLUMN size_chart_id INTEGER REFERENCES size_charts(id) ON DELETE SET NULL;

-- Starting library: the charts supplied by Veeess Knits (26 Oct 2026).
INSERT INTO size_charts (name, src) VALUES
  ('Drop shoulder T-shirt · M–XL (chest 40–44)', '/images/size-charts/drop-shoulder-tee-40-44.jpg'),
  ('Drop shoulder T-shirt · M–XL (chest 42–46)', '/images/size-charts/drop-shoulder-tee-42-46.jpg'),
  ('Men''s T-shirt · XXS–S', '/images/size-charts/mens-tee-xxs-s.jpg'),
  ('Baby romper · 0–24 months', '/images/size-charts/baby-romper.jpg'),
  ('Women''s T-shirt · S–3XL', '/images/size-charts/womens-tee-s-3xl.jpg'),
  ('Boys'' T-shirt · 6 months–16 years', '/images/size-charts/boys-tee-6m-16y.jpg'),
  ('T-shirt · S–4XL (shoulder 15–21)', '/images/size-charts/tee-s-4xl-shoulder-15-21.jpg'),
  ('T-shirt · S–4XL (shoulder 14–20)', '/images/size-charts/tee-s-4xl-shoulder-14-20.jpg'),
  ('Wordle shorts · M–XL', '/images/size-charts/wordle-shorts-m-xl.jpg'),
  ('Kids track pant · 12 months–16 years', '/images/size-charts/kids-track-pant-12m-16y.jpg');

-- Sample products: kidswear is for kids; link a sensible chart to the sample styles.
UPDATE products SET audience = 'kids' WHERE category_id = (SELECT id FROM categories WHERE slug = 'kidswear');
UPDATE products SET size_chart_id = (SELECT id FROM size_charts WHERE src LIKE '%drop-shoulder-tee-42-46%') WHERE slug = 'wordle-heavyweight-oversized-tee';
UPDATE products SET size_chart_id = (SELECT id FROM size_charts WHERE src LIKE '%tee-s-4xl-shoulder-15-21%') WHERE slug IN ('wordle-classic-crew-tee', 'wordle-graphic-print-tee');
UPDATE products SET size_chart_id = (SELECT id FROM size_charts WHERE src LIKE '%boys-tee-6m-16y%') WHERE slug = 'wordle-kids-crew-tee';
UPDATE products SET size_chart_id = (SELECT id FROM size_charts WHERE src LIKE '%wordle-shorts-m-xl%') WHERE slug = 'wordle-lounge-shorts';
