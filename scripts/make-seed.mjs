// One-off generator for migrations/0002_seed.sql (sample catalogue).
// Prices, stock and descriptions are SAMPLE values — replace via the admin panel.
// HISTORICAL: this produced 0002 with two brands. Max8 was retired later; migration
// 0004_wordle_only.sql moves everything to Wordle. Do not re-run to change 0002.
import { writeFileSync } from 'node:fs';
const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const brands = [
  [1, 'Wordle', 'wordle', 'Graphic, statement pieces with heavy workmanship.'],
  [2, 'Max8', 'max8', 'Clean, minimal everyday essentials.'],
];
const cats = [[1,'T-shirts','t-shirts',1],[2,'Shirts','shirts',2],[3,'Shorts','shorts',3],[4,'Track pants','track-pants',4],[5,'Sleeveless','sleeveless',5],[6,'Kidswear','kidswear',6]];
const ADULT = ['S','M','L','XL','XXL'];
const KIDS = ['2-3Y','4-5Y','6-7Y','8-9Y'];
const products = [
  { id:1, brand:1, cat:1, name:'Wordle Heavyweight Oversized Tee', slug:'wordle-heavyweight-oversized-tee', price:79900, mrp:99900, gsm:240, fabric:'100% combed cotton, bio-washed', isNew:1,
    desc:'A boxy, dropped-shoulder tee in heavyweight cotton with the Wordle chest print. Pre-shrunk and shrinkage-tested.',
    colours:[['Jet black','#1C1C1E',['/images/products/hero.jpg','/images/products/view-back.jpg','/images/products/view-detail.jpg']],['Off white','#F2EFE6',['/images/products/p1.jpg']]], sizes:ADULT },
  { id:2, brand:2, cat:1, name:'Max8 Classic Crew Tee', slug:'max8-classic-crew-tee', price:59900, mrp:69900, gsm:180, fabric:'100% combed cotton', isNew:1,
    desc:'An everyday regular-fit crew neck with a small Max8 print. Soft, breathable and made to last wash after wash.',
    colours:[['Olive','#5E6B3A',['/images/products/p2.jpg']],['Indigo','#2C3A6E',['/images/products/cat-tshirts.jpg']]], sizes:ADULT },
  { id:3, brand:1, cat:4, name:'Wordle Side-Stripe Track Pants', slug:'wordle-side-stripe-track-pants', price:109900, mrp:129900, gsm:260, fabric:'Cotton-rich fleece back', isNew:1,
    desc:'Tapered track pants with contrast side stripes, drawcord waist and ribbed cuffs.',
    colours:[['Indigo','#2C3A6E',['/images/products/p3.jpg']],['Midnight','#1F2233',['/images/products/cat-trackpants.jpg']]], sizes:ADULT },
  { id:4, brand:2, cat:6, name:'Max8 Kids Crew Tee', slug:'max8-kids-crew-tee', price:44900, mrp:null, gsm:160, fabric:'100% soft cotton', isNew:1,
    desc:'A soft, easy-wear tee for kids with a playful Max8 print.',
    colours:[['Sky','#C9D6E8',['/images/products/p4.jpg']],['Mustard','#E6B83A',['/images/products/cat-kids.jpg']]], sizes:KIDS },
  { id:5, brand:2, cat:2, name:'Max8 Knit Casual Shirt', slug:'max8-knit-casual-shirt', price:99900, mrp:119900, gsm:200, fabric:'Cotton knit', isNew:0,
    desc:'A relaxed knit shirt with a chest pocket — the comfort of a tee with the look of a shirt.',
    colours:[['Sage','#8A9A7B',['/images/products/cat-shirts.jpg']]], sizes:ADULT },
  { id:6, brand:1, cat:3, name:'Wordle Lounge Shorts', slug:'wordle-lounge-shorts', price:64900, mrp:null, gsm:220, fabric:'Cotton terry', isNew:0,
    desc:'Easy lounge shorts with an elastic drawcord waist and side pockets.',
    colours:[['Charcoal','#3B3F4A',['/images/products/cat-shorts.jpg']]], sizes:ADULT },
  { id:7, brand:2, cat:5, name:'Max8 Sleeveless Vest', slug:'max8-sleeveless-vest', price:49900, mrp:null, gsm:180, fabric:'100% combed cotton', isNew:0,
    desc:'A clean sleeveless vest for training or warm days.',
    colours:[['Rust','#B5502F',['/images/products/cat-sleeveless.jpg']]], sizes:ADULT },
  { id:8, brand:1, cat:1, name:'Wordle Graphic Print Tee', slug:'wordle-graphic-print-tee', price:84900, mrp:99900, gsm:220, fabric:'100% combed cotton', isNew:0,
    desc:'A regular-fit tee with a bold Wordle front print in rust.',
    colours:[['Off white','#F2EFE6',['/images/products/studio-print.jpg']]], sizes:ADULT },
];
let sql = '-- SAMPLE catalogue: names, prices and stock are placeholders to be replaced in the admin panel.\n';
for (const b of brands) sql += `INSERT INTO brands (id,name,slug,tagline) VALUES (${b[0]},${q(b[1])},${q(b[2])},${q(b[3])});\n`;
for (const c of cats) sql += `INSERT INTO categories (id,name,slug,sort_order) VALUES (${c[0]},${q(c[1])},${q(c[2])},${c[3]});\n`;
let vid = 1, iid = 1;
for (const p of products) {
  sql += `INSERT INTO products (id,brand_id,category_id,name,slug,description,fabric,gsm,care,is_active,is_new) VALUES (${p.id},${p.brand},${p.cat},${q(p.name)},${q(p.slug)},${q(p.desc)},${q(p.fabric)},${p.gsm},${q('Machine wash cold, inside out. Do not bleach. Dry in shade.')},1,${p.isNew});\n`;
  let so = 0;
  for (const [colour, hex, imgs] of p.colours) {
    imgs.forEach((src, i) => { sql += `INSERT INTO product_images (id,product_id,colour,src,alt,sort_order) VALUES (${iid++},${p.id},${q(colour)},${q(src)},${q(p.name + ' in ' + colour)},${so * 10 + i});\n`; });
    for (const size of p.sizes) {
      const sku = `VK${String(p.id).padStart(3,'0')}-${colour.replace(/\s+/g,'').slice(0,4).toUpperCase()}-${size.replace('-','')}`;
      const stock = size === 'XXL' ? 3 : 12;
      sql += `INSERT INTO product_variants (id,product_id,colour,colour_hex,size,sku,price_paise,mrp_paise,stock,reserved,sort_order) VALUES (${vid++},${p.id},${q(colour)},${q(hex)},${q(size)},${q(sku)},${p.price},${p.mrp ?? 'NULL'},${stock},0,${so * 100 + p.sizes.indexOf(size)});\n`;
    }
    so++;
  }
}
writeFileSync(new URL('../migrations/0002_seed.sql', import.meta.url), sql);
console.log('variants', vid - 1, 'images', iid - 1);
