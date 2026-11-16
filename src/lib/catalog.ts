import data from '../data/catalog.json';

export interface Variant { id: number; colour: string; colour_hex: string; size: string; price_paise: number; mrp_paise: number | null; available: number }
export interface Product {
  id: number; name: string; slug: string; description: string; fabric: string; gsm: number | null; care: string; is_new: number;
  audience: 'men' | 'women' | 'unisex' | 'kids';
  sizeChart: { name: string; src: string } | null;
  brand: { id: number; name: string; slug: string; tagline: string };
  category: { id: number; name: string; slug: string };
  minPricePaise: number; mrpPaise: number | null;
  colours: { name: string; hex: string }[]; sizes: string[];
  variants: Variant[]; images: { src: string; alt: string; colour: string | null }[];
}
export const catalog = data as unknown as {
  generatedAt: string;
  brands: { id: number; name: string; slug: string; tagline: string }[];
  categories: { id: number; name: string; slug: string; sort_order: number }[];
  products: Product[];
};
export const products = catalog.products;

export function formatINR(paise: number): string {
  const r = paise / 100;
  return '₹' + r.toLocaleString('en-IN', { minimumFractionDigits: r % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
export function discountPct(price: number, mrp: number | null): number {
  return mrp && mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0;
}
export function inStock(p: Product): boolean { return p.variants.some((v) => v.available > 0); }
export function categoryImage(slug: string): string {
  const map: Record<string, string> = {
    // Real photos (D53); kidswear keeps the illustration until a photo is supplied. Old cat-*.jpg files are kept.
    't-shirts': '/images/categories/t-shirts.jpg', shirts: '/images/categories/shirts.jpg', shorts: '/images/categories/shorts.jpg',
    'track-pants': '/images/categories/track-pants.jpg', sleeveless: '/images/categories/sleeveless.jpg', kidswear: '/images/products/cat-kids.jpg',
  };
  return map[slug] ?? '/images/products/p1.jpg';
}
