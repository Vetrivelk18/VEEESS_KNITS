/** Who a product is for. Men's/Women's pages also show Unisex products. */
export const AUDIENCES = [
  { id: 'men', label: 'Men', plural: "Men's" },
  { id: 'women', label: 'Women', plural: "Women's" },
  { id: 'unisex', label: 'Unisex', plural: 'Unisex' },
  { id: 'kids', label: 'Kids', plural: 'Kids' },
] as const;
export type Audience = (typeof AUDIENCES)[number]['id'];
export const AUDIENCE_IDS = AUDIENCES.map((a) => a.id) as [Audience, ...Audience[]];

/** Should a product with this audience appear on the page for `page`? */
export function showsOn(page: 'men' | 'women' | 'kids', audience: string): boolean {
  if (page === 'kids') return audience === 'kids';
  return audience === page || audience === 'unisex';
}
