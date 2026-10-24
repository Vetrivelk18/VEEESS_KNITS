import { z } from 'zod';
import { ApiError } from './http';

// Reject control characters and angle brackets in free text (defence in depth;
// all output is also escaped where it is displayed).
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]*$/;
const safeText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).regex(SAFE_TEXT, 'Contains characters that are not allowed');

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
] as const;

/** Normalise to a 10-digit Indian mobile number, e.g. "+91 98765 43210" → "9876543210". */
export function normalisePhone(raw: string): string {
  let d = raw.replace(/[\s\-()]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.startsWith('91') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  return d;
}

export const phoneSchema = z
  .string()
  .max(20)
  .transform(normalisePhone)
  .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit Indian mobile number');

export const checkoutSchema = z.object({
  items: z
    .array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(10) }))
    .min(1, 'Your cart is empty')
    .max(20),
  customer: z.object({
    name: safeText(2, 80),
    phone: phoneSchema,
    email: z.string().trim().toLowerCase().email().max(120),
  }),
  address: z.object({
    line1: safeText(3, 120),
    line2: safeText(0, 120).optional().default(''),
    city: safeText(2, 60),
    state: z.enum(INDIAN_STATES),
    pincode: z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code'),
  }),
  paymentMethod: z.enum(['razorpay', 'cod']),
  turnstileToken: z.string().max(2048).optional(),
  consent: z.literal(true, { error: 'Please accept the terms and privacy policy' }),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const verifyPaymentSchema = z.object({
  orderId: z.string().uuid(),
  razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/),
  razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
  razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ORDER_STATUSES = [
  'created', 'paid', 'cod_pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded', 'expired', 'failed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const statusUpdateSchema = z.object({
  status: z.enum(['confirmed', 'packed', 'shipped', 'delivered', 'cancelled']),
  trackingNumber: safeText(0, 60).optional(),
});

export const variantUpdateSchema = z.object({
  pricePaise: z.number().int().min(100).max(10_000_000).optional(),
  mrpPaise: z.number().int().min(100).max(10_000_000).nullable().optional(),
  stock: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
});

export const productUpsertSchema = z.object({
  name: safeText(3, 100),
  brandId: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  description: safeText(0, 2000),
  fabric: safeText(0, 120),
  gsm: z.number().int().min(80).max(600).nullable(),
  care: safeText(0, 300),
  isActive: z.boolean(),
  isNew: z.boolean(),
});

export const newVariantSchema = z.object({
  colour: safeText(2, 40),
  colourHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  size: safeText(1, 12),
  pricePaise: z.number().int().min(100).max(10_000_000),
  mrpPaise: z.number().int().min(100).max(10_000_000).nullable(),
  stock: z.number().int().min(0).max(100_000),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).optional(),
});

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new ApiError(400, 'invalid_input', first ? `${first.path.map(String).join('.') || 'input'}: ${first.message}` : 'Invalid input', {
      fields: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    });
  }
  return r.data;
}
