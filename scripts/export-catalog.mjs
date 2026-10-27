// Exports the live catalogue from D1 into src/data/catalog.json, which Astro
// uses to pre-build the static shop pages.
//   CATALOG_SOURCE=remote  -> production D1 (needs CLOUDFLARE_API_TOKEN), used in CI
//   CATALOG_SOURCE=local   -> local dev D1 (default when no API token)
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const source = process.env.CATALOG_SOURCE ?? (process.env.CLOUDFLARE_API_TOKEN ? 'remote' : 'local');
const mediaBase = (process.env.PUBLIC_MEDIA_BASE ?? '/media').replace(/\/$/, '');
const out = new URL('../src/data/catalog.json', import.meta.url);

function q(sql) {
  const raw = execFileSync('npx', ['wrangler', 'd1', 'execute', 'veeess_db', `--${source}`, '--json', '--command', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const start = raw.indexOf('[');
  return JSON.parse(raw.slice(start))[0].results;
}

try {
  const brands = q('SELECT id, name, slug, tagline FROM brands ORDER BY id');
  const categories = q('SELECT id, name, slug, sort_order FROM categories ORDER BY sort_order');
  const products = q(
    `SELECT p.id, p.name, p.slug, p.description, p.fabric, p.gsm, p.care, p.is_new, p.brand_id, p.category_id, p.audience,
            s.name AS size_chart_name, s.src AS size_chart_src
       FROM products p LEFT JOIN size_charts s ON s.id = p.size_chart_id
      WHERE p.is_active = 1 ORDER BY p.is_new DESC, p.id`,
  );
  const variants = q(
    `SELECT id, product_id, colour, colour_hex, size, price_paise, mrp_paise, MAX(stock - reserved, 0) AS available
       FROM product_variants WHERE is_active = 1 ORDER BY product_id, sort_order`,
  );
  const images = q('SELECT product_id, colour, src, alt FROM product_images ORDER BY product_id, sort_order');
  const resolve = (src) => (src.startsWith('r2:') ? `${mediaBase}/${src.slice(3)}` : src);

  const catalog = {
    generatedAt: new Date().toISOString(),
    brands,
    categories,
    products: products
      .map((p) => {
        const vs = variants.filter((v) => v.product_id === p.id);
        if (!vs.length) return null;
        const colours = [];
        for (const v of vs) if (!colours.find((c) => c.name === v.colour)) colours.push({ name: v.colour, hex: v.colour_hex });
        const imgs = images.filter((i) => i.product_id === p.id).map((i) => ({ src: resolve(i.src), alt: i.alt, colour: i.colour }));
        const prices = vs.map((v) => v.price_paise);
        const mrps = vs.map((v) => v.mrp_paise).filter(Boolean);
        const { size_chart_name, size_chart_src, ...rest } = p;
        return {
          ...rest,
          audience: p.audience ?? 'unisex',
          sizeChart: size_chart_src ? { name: size_chart_name, src: resolve(size_chart_src) } : null,
          brand: brands.find((b) => b.id === p.brand_id),
          category: categories.find((c) => c.id === p.category_id),
          minPricePaise: Math.min(...prices),
          mrpPaise: mrps.length ? Math.max(...mrps) : null,
          colours,
          sizes: [...new Set(vs.map((v) => v.size))],
          variants: vs.map(({ product_id, ...v }) => v),
          images: imgs,
        };
      })
      .filter(Boolean),
  };
  mkdirSync(new URL('../src/data/', import.meta.url), { recursive: true });
  writeFileSync(out, JSON.stringify(catalog, null, 2));
  console.log(`catalog: ${catalog.products.length} products from ${source} D1`);
} catch (err) {
  if (existsSync(out)) {
    console.warn(`catalog export from ${source} D1 failed; keeping existing src/data/catalog.json`);
    console.warn(String(err.stderr ?? err.message).slice(0, 500));
  } else {
    console.error('catalog export failed and no existing catalog.json');
    throw err;
  }
}
