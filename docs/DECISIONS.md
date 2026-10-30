# Veeess Knits — Decisions and assumptions

A running log of the important choices made while building, so you can review and change them. Each entry says **what** was decided, **why**, and **how to change it**. Items marked **ASSUMPTION** are guesses that need confirming with Veeess Knits.

Last updated: 24 Oct 2026 · Code version 0.2.0

---

## 1. Platform and architecture

### D1. Cloudflare Worker with static assets (instead of Cloudflare Pages)
- **What:** One Cloudflare Worker serves the Astro-built static site (`./dist`) and the API. Static files are served for free; only `/api/*`, `/media/*` and `/admin/*` run Worker code.
- **Why:** Cloudflare Pages cannot run scheduled jobs (cron). We need cron for payment reconciliation, order expiry, admin re-alerts and backups. Workers with static assets has the same free, unlimited static serving, plus cron, in one deploy. This is a change from the HLD, which said "Pages".
- **Change it:** not recommended; Pages would need a second Worker just for cron.

### D2. Static storefront pages, rebuilt when the catalogue changes
- **What:** Home, shop, category, brand and product pages are pre-built HTML (good for speed, SEO and the free plan). Live price and stock are fetched from `/api/products/:slug` when a product page opens, and the server re-checks everything at checkout.
- **Why:** Rendering every page on the server would count every page view against the 100,000 requests/day limit and the 10 ms CPU limit.
- **Consequence:** New products, names, descriptions and images appear on the site after a rebuild. The admin panel has a **Publish storefront** button that triggers a rebuild through GitHub Actions (takes about 1–2 minutes). Price and stock changes show immediately without a rebuild.

### D3. Fewer dependencies (security choice)
- **What:** Runtime dependencies are only `hono` (routing) and `zod` (input validation). No ORM, no UI framework, no CSS framework.
- **Why:** Every dependency is code that can carry vulnerabilities. Database access uses D1 prepared statements with bound parameters, which prevents SQL injection without an ORM. The HLD mentioned Drizzle ORM and Tailwind; both were dropped for this reason.
- **Change it:** either can be added later without changing the database.

### D4. Pinned to Astro 5
- **What:** Astro 5.18 is used instead of the newest major version.
- **Why:** It is a mature, well-documented release. Upgrade later in a separate change.

### D5. Fonts are self-hosted
- **What:** Archivo and Instrument Sans are bundled from npm (`@fontsource`) instead of loaded from Google Fonts.
- **Why:** Faster first load, no third-party request with the customer's IP, and a tighter Content-Security-Policy.

---

## 2. Catalogue and pricing

### D6. Sample catalogue — ASSUMPTION
- 8 sample products (originally across Wordle and Max8; all Wordle since D36) and all 6 categories, with **sample prices, MRPs, stock levels and descriptions**. The product photos are the generated mock-up images.
- **Replace** all of these in the admin panel before launch (open question in the HLD: real photos, prices, size charts).

### D7. Shipping charge — PENDING (owner will set)
- **26 Oct 2026:** the ₹999 free-shipping offer and ₹79 fee were removed from the site (owner decision). Delivery is **free for now** (`SHIPPING_FEE_PAISE` = `0`, `FREE_SHIPPING_MIN_PAISE` = `0` in `wrangler.jsonc`).
- To charge later: set `SHIPPING_FEE_PAISE` (e.g. `7900` = ₹79) and optionally `FREE_SHIPPING_MIN_PAISE` for a free-delivery threshold, then deploy. The cart and checkout show whatever is set; no page advertises a fixed amount.

### D8. Prices include GST
- Prices are shown and charged as GST-inclusive ("Inclusive of all taxes"). GST invoice generation is **not** built yet — waiting on whether the company is GST-registered (HLD open question).

### D9. Quantity limit
- Maximum 10 of one item per order and 20 items per order, to stop bulk/abusive orders now that B2B is out of scope.

---

## 3. Orders, payments and cash on delivery

### D10. Stock is protected by the database itself
- A `CHECK (reserved <= stock AND stock >= 0)` rule on `product_variants` means two shoppers can never both buy the last item, even at the same millisecond — the second checkout fails and rolls back cleanly ("Sorry, an item just sold out").
- **Online orders** reserve stock at checkout and convert it to a sale when payment is confirmed. Unpaid reservations are released after **30 minutes** (`ORDER_EXPIRY_MINUTES`).
- **COD orders** take stock immediately (there is no payment step). Cancelling a COD order in the admin panel puts the stock back.

### D11. A payment is confirmed three ways, but counted once
- Browser verify (signature check) → Razorpay webhook → 15-minute reconciliation job. Whichever arrives first marks the order paid; the others do nothing. The payment ID is unique in the database and each webhook event ID is stored, so replays are ignored.
- On top of the signature, the server asks Razorpay for the payment and checks it is **captured** and the **amount and currency match** the order. A mismatch is flagged "needs attention" in the admin panel.
- **ASSUMPTION / ACTION:** turn on **automatic capture** in the Razorpay dashboard (Settings → Payment capture). Only captured payments mark an order paid.
- If a customer pays *after* their reservation expired, the order is still marked paid; if the item has since sold out it is flagged **OUT OF STOCK — refund or restock** for the admin.

### D12. Cash on delivery rules
- COD has **no extra charge** (the database enforces `cod_fee_paise = 0`).
- A phone number can have at most **2 open COD orders** (`COD_MAX_OPEN_PER_PHONE`). Open = pending, confirmed, packed or shipped.
- Optional maximum COD order value: `COD_MAX_ORDER_PAISE` (set to `0` = no limit, because this is still an open question).
- New COD orders arrive as **"COD to confirm"**. The admin confirms (e.g. by a quick call) before packing. Whether to always phone first is an open question in the HLD.

### D13. Order status rules (enforced on the server)
| From | Allowed next |
| --- | --- |
| COD to confirm | Confirmed, Cancelled |
| Confirmed (COD) | Packed, Cancelled |
| Paid (online) | Packed (cancel = refund) |
| Packed | Shipped (tracking number required), Cancelled (COD only) |
| Shipped | Delivered |
- Online-paid orders are cancelled only through **Refund** (full amount). Refunding a paid/packed order puts stock back; refunding a shipped/delivered one does not (returns are handled by hand).
- Abandoned online checkouts (never paid) are hidden from the main order list.

### D14. Customer order page uses a signed link
- The order confirmation page and email link carry a signed token valid for **6 months** (was 30 days; see D40). Without it, an order ID shows nothing, so nobody can look up other people's orders by guessing.

### D15. Guest checkout only
- No customer accounts or passwords (nothing to leak or reset). Customers are identified by mobile number. Accounts can be added later.

### D16. Mock payments for local testing only
- `RAZORPAY_MOCK=1` replaces the Razorpay popup with a local simulator so the whole flow can be tested offline. It is ignored unless `ENVIRONMENT=development` **and** the request is to `localhost`. A unit test checks it can never activate in production.

---

## 4. Security (primary focus)

### D17. Admin login: Cloudflare Access + our own verification
- Cloudflare Access (free, up to 50 users) asks admins for an email one-time code before `/admin` and `/api/admin` are reachable.
- The Worker does **not** trust Access blindly: it verifies the Access JWT signature (RS256) against Cloudflare's public keys, checks audience, issuer and expiry, and requires the email to be in `ADMIN_EMAILS`. If Access were ever misconfigured, the admin area still returns 401.
- **ACTION:** put the 2–3 real admin emails in `ADMIN_EMAILS` and in the Access policy (HLD open question).

### D18. Other protections built in
| Threat | Protection in the code |
| --- | --- |
| Price tampering | Server prices every cart from the database; browser prices are ignored (unit-tested). |
| Fake payment success | HMAC-SHA256 signature check (constant-time compare) + Razorpay API confirmation of capture and amount. |
| Webhook forgery / replay | HMAC of the raw body with the webhook secret; event IDs stored. |
| Cross-site request forgery | Every POST/PATCH/DELETE must come from our own origin and be JSON; Razorpay's webhook is the only exception (it is signed). |
| SQL injection | Only prepared statements with bound parameters; search input is escaped for `LIKE`. |
| XSS | Free text rejects `<`, `>` and control characters; pages render text with `textContent`, never `innerHTML` with user data; emails are HTML-escaped; strict Content-Security-Policy. |
| Bots, fake COD orders | Cloudflare Turnstile on checkout (verified server-side, fails closed), rate limits per IP and per phone, COD caps. |
| Brute force / abuse | Rate limits stored in D1 on checkout, order lookup, verify, refunds, uploads, publish. |
| Malicious uploads | Admin-only; JPEG/PNG/WebP detected by file signature (not file name); 5 MB limit; random file names; served with `sandbox` CSP. |
| SSRF via push endpoints | Only real browser push services (Google, Apple, Mozilla, Microsoft) can be registered. |
| Leaking customer data | Push notifications carry **no data**; alert text and admin emails never include address or phone. Error messages never include internals. |
| Secrets | Only in Cloudflare encrypted secrets / `.dev.vars` (git-ignored). The app refuses to process payments if a secret is missing or still a placeholder. |
| Clickjacking, sniffing | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, HSTS, Referrer-Policy, Permissions-Policy. |
| Accountability | Every admin change (status, refund, price, stock, upload, publish) is written to an audit log with email, IP and time. |
| Order details tampering | Each order stores the name and email given at that checkout, so someone ordering with another person's phone number can't alter how that person's earlier orders look or where their emails go. |
| Lost webhook on a crash | A webhook event is marked "seen" only after it has been processed, so Razorpay's retry still works; the 15-minute reconciliation is a second safety net. |

### D19. Rate limiting stored in D1
- Free-plan friendly, but each limited request costs one database write. **ACTION:** also add Cloudflare's free WAF rate-limiting rule on `/api/checkout` (README has the exact rule) so floods are stopped before they reach the Worker.

---

## 5. Admin panel and new-order alerts

### D20. Four layers of alerts
1. **In the panel:** bell with unread count, pop-up card with "View order", a short two-tone chime, and the unread count in the browser tab title. The panel checks every **20 seconds** while visible (and immediately when the tab is reopened).
2. **Web Push** to every admin device that turned alerts on, even with the panel closed. Tapping it opens that order.
3. **Backup email** to `ALERT_EMAIL_TO` for every new order (needs a Resend API key).
4. **Re-alert:** if no admin opens a new order within **15 minutes**, every device is pushed again (once).
- An alert is created only when an order becomes **paid** (online) or **COD to confirm** — never for abandoned checkouts. One alert per order, guaranteed by the database.
- Opening the order, acting on it, or "Mark all read" clears it **for all admins** and records who saw it.

### D21. Push notifications carry no customer data
- The push is an empty "wake-up"; the admin device's service worker then fetches the alert text from our API (behind Cloudflare Access). Lock-screen text is only "New order VK-1043 · ₹1,299 · COD · 2 items · Priya" — no address or phone.
- **iPhone limitation:** web push needs iOS 16.4+ and the admin panel added to the Home Screen. The Alert settings page explains this. Admins can also rely on the backup email.

### D22. The chime needs one tap
- Browsers block sound until the user interacts with the page. After the first tap/click anywhere in the admin panel, the chime works for the rest of the session.

### D23. Two-step confirm for risky actions
- "Cancel order" and "Refund" need a second tap within 4 seconds instead of a pop-up dialog. Refunds are always the full amount; partial refunds can be done in the Razorpay dashboard.

### D24. Shipping requires a courier and a tracking number
- An order can't be marked **Shipped** without choosing the courier and typing its tracking number (see D38).

### D25. Mobile-first admin
- On phones the orders table becomes cards with one big action button ("Confirm COD", "Mark packed", …). The admin panel can be installed to the Home Screen (it has a web app manifest and icon).

---

## 6. Storefront

### D26. Follows the approved design, with these enhancements
- Sticky header and a bottom tab bar on phones (Home, Shop, Track order, Cart with item count).
- Live stock on product pages: sold-out sizes are crossed out, "Only N left" under 4 units.
- Cart re-prices from the server every time it opens and blocks checkout if an item ran out.
- "Buy now" goes straight to checkout; checkout shows "Cash on delivery charge — Free" when COD is selected.
- Product pages include structured data (Google Shopping/SEO); `robots.txt` hides admin, API, checkout and order pages.
- Accessibility: skip link, labelled buttons, keyboard-usable controls, visible focus, 44 px touch targets.

### D27. Track order page uses the emailed link — ASSUMPTION
- The "Track order" tab explains that orders open from the private link in the confirmation email (or by phone/WhatsApp). There is deliberately **no** "enter order number + phone" lookup, to stop people looking up others' orders. A one-time-code lookup can be added later.

### D28. WhatsApp number — ASSUMPTION
- "Chat on WhatsApp" links to **+91 96006 86606**, the number the current Wix site uses for WhatsApp. Confirm it.

### D29. Policy pages are drafts
- Shipping, returns, privacy and terms pages contain draft wording with **[bracketed]** gaps (return window, dispatch time, grievance officer). They must be reviewed before launch. This is not legal advice.

### D30. Size charts not yet built
- The product page shows a placeholder size-chart note. Real measurements per style are needed from Veeess Knits.

---

## 7. Deployment and operations

### D31. GitHub Actions deploys; "Publish storefront" rebuilds
- Push to `main` → tests → database migrations → catalogue export from live D1 → build → deploy. The admin's Publish button triggers the same workflow (needs `GITHUB_REPO` + `GITHUB_DISPATCH_TOKEN`).
- Dependabot opens weekly update PRs; CI runs `npm audit` for high-severity issues.

### D32. Backups
- D1 Time Travel (point-in-time restore) plus a weekly JSON export of all business tables to the private R2 bucket (`backups/`, last 12 kept). Backups are not reachable through `/media/`.

### D34. Local admin sign-in replaces Cloudflare Access on your computer
- **What:** On `localhost`, unauthenticated admin pages redirect to `/__local/login`, where you pick an admin from `ADMIN_EMAILS`. A signed, HttpOnly session cookie (8 hours, invalid after a dev-server restart) then works like the Access session; **Sign out** clears it. The admin panel shows a yellow **LOCAL TEST MODE** bar.
- **Why:** Cloudflare Access only exists on the live site, so the admin panel couldn't be opened locally. This keeps the real flow (redirect → sign in → act as a named admin → sign out) instead of silently skipping login, so you can test two admins, "seen by" and shared alerts.
- **When it is on:** only if `ENVIRONMENT=development` **and** `LOCAL_ADMIN_BYPASS=1` (both in `.dev.vars`) **and** the request is to localhost/127.0.0.1. Otherwise `/__local/*` returns 404 and admin pages require Cloudflare Access as before.
- **Guards:** `npm run check:prod` blocks deploys containing local settings; CI boots the Worker with live settings and checks the admin area stays locked (`npm run smoke`); 14 automated tests cover the on/off rules, forged/expired cookies, cross-site sign-in and redirects. In development only, a locked admin page explains which setting is missing; production never shows these hints.
- **Replaces:** the earlier `DEV_ADMIN_EMAIL` auto-login (now it only pre-selects the email on the sign-in page).
- **Cause of the original problem:** the first upload to GitHub didn't include hidden files (`.dev.vars.example`, `.github/`). Without `.dev.vars`, the app ran with live settings locally and asked for Cloudflare Access. Both are restored, and `npm run setup:local` creates `.dev.vars` in one step.

### D35. CI blocks known-vulnerable dependencies
- CI runs `npm audit --omit=dev --audit-level=high`; a high-severity advisory in any production dependency fails the build.
- **24 Oct 2026:** it caught GHSA-mrhx-c7xc-m3w5 in `zod` 3.x (memory exhaustion when validating oversized collections). Upgraded to **zod 4.6.7**. Two code changes: the consent error message syntax and the shared `parse()` helper type. Validation messages shown to customers are unchanged. The app was already partly protected (request bodies are capped at 32 KB before validation), but the upgrade removes the issue.
- Dependabot opens weekly update PRs so fixes like this arrive automatically.

### D36. Wordle is the only brand; logo and Wordle artwork (24 Oct 2026)
- **Decision (owner):** Max8 is removed everywhere. Every product is Wordle, always.
- **Database:** migration `0004_wordle_only.sql` renames the four sample "Max8 …" products to "Wordle …" (new slugs `wordle-…`), moves every product to Wordle, deletes the Max8 brand and adds **triggers** so the database itself refuses a non-Wordle product or a new brand. Past orders keep the product names they were bought under.
- **API/admin:** the brand picker is gone from the admin product form; the server always saves products as Wordle and ignores any `brandId` sent.
- **Storefront:** brand pages (`/brand/…`) removed; the brand label on product cards became a "New" tag for new products; breadcrumbs are Home / Shop / Category; related products are by category.
- **Old links:** `public/_redirects` sends `/brand/*` to `/shop/` and the four old `/p/max8-…/` URLs to their Wordle versions (301).
- **Logo:** the header shows the round VK emblem before "VEEESS KNITS", cropped from `logo_vk.jpeg` (64/128/256 px), also used as favicon and home-screen icon. ASSUMPTION: the supplied logo is a photo mock-up; a flat PNG/SVG of the emblem would be sharper — swap the files in `public/images/brand/` when available.
- **Wordle artwork:** the large "WORDLe" text block on the home page is replaced by the supplied `wordle.jpeg` (trimmed, `wordle-wordmark.jpg`) on its matching cream background (#FDECD8). The sample product photos that showed "MAX8" now show the Wordle print.
- Not changed: the HLD and design canvas documents still show Max8 (historical design docs).

### D37. No returns; 3 admins (26 Oct 2026)
- **No returns or exchanges (owner decision, strict).** The returns policy, terms, product pages and checkout consent all say all sales are final. Cancellation before shipping (with a full refund for online payments) is unchanged. ASSUMPTION/NOTE: Indian consumer law can still require a remedy for defective or wrong items regardless of a no-returns policy — worth confirming with a lawyer/CA before launch. This is not legal advice.
- **3 admins.** `ADMIN_EMAILS` holds three placeholders until the real emails are given; they must match the Cloudflare Access policy. The deploy check warns while placeholders remain. `ALERT_EMAIL_TO` now accepts several comma-separated inboxes, so all 3 admins can get the backup alert email; push alerts already work per admin device.

### D38. Courier choice, tracking button and "shipped" email (26 Oct 2026)
- When marking an order shipped, the admin picks the courier — **DTDC, Delhivery, ST Courier, India Post, The Professional Couriers or Other** — and types the tracking number. The list lives in `shared/couriers.ts`; the database only accepts these values (migration `0005`).
- The customer's order page shows "Shipped with DTDC", the tracking number with a **Copy** button, and a **Track on DTDC →** button that opens the courier's official tracking page. "Other" shows the number and our phone/WhatsApp instead.
- ASSUMPTION: courier sites don't reliably accept the tracking number inside the link (Delhivery returns 404, DTDC needs a captcha), so the button opens the tracking page and the customer pastes the number. Links checked 26 Oct 2026; if a courier changes its site, update `shared/couriers.ts`.
- The customer automatically gets a **"Your order has shipped"** email (courier, tracking number, track button, order-status link). It is sent at most once per order, and the admin panel shows when it was sent. Needs the Resend email key (go-live setup); without it nothing is sent and the panel shows no "sent" time.
- Not done: changing the courier/tracking number after marking shipped (call the customer if a number was mistyped), and SMS/WhatsApp messages.

### D39. Size charts and Men / Women / Kids (27 Oct 2026)
- **Size charts are images** uploaded by admins (owner decision: upload as-is). They live in a **library** (Products → Size charts): upload a chart once, then pick it on each product that uses it. The 10 charts supplied on 27 Oct 2026 are pre-loaded (migration `0006`), and the sample products have a sensible chart linked.
- On the product page, the **Size chart** link next to the sizes opens the chart in a **popup** (Esc, ✕ or tapping outside closes it), with the no-returns reminder. Products without a chart show the call/WhatsApp line in the same popup.
- **New products can be created with photos** straight from "Add a new product"; the panel then scrolls to the new product to add sizes and prices.
- Each product has **For: Men, Women, Unisex or Kids** (database-checked). New pages **/men/**, **/women/**, **/kids/** and "Everyone · Men · Women · Kids" chips on the shop; **Unisex shows under both Men and Women**. The main menu is now Shop · Men · Women · Kids · Our story · Track order.
- Uploaded charts are stored in R2 under `size-charts/`; only that exact pattern (and product photos) is publicly served — backups stay private.
- ASSUMPTION: chart names are my descriptions of the supplied images (e.g. "Women's T-shirt · S–3XL"); admins can upload a renamed copy. Charts are images, so they can't be searched or converted to cm.

### D40. Order tracking without customer accounts (27 Oct 2026)
- **Owner decision:** no login for now. Customers track with their private order link (in the confirmation and "shipped" emails), now valid for **6 months**.
- The order page **refreshes itself** every minute while the order is still moving, and when the customer comes back to the tab; it has a **Copy order link** button.
- **Parked for later** (discussed 26–27 Oct): "Find my orders" by email code (free), then mobile OTP by SMS (needs an SMS provider and DLT registration), and full customer accounts.

### D41. Deleting products (27 Oct 2026)
- Admins can **permanently delete a product that has never been ordered** (Products → open product → Delete product, tap twice). It removes the product, its sizes and its photos (also from storage). Useful for test products and mistakes.
- A product with any order (including unpaid online checkouts) **can't be deleted** — the panel says how many orders it has and suggests unticking "Show in shop" instead. The server checks this, and the database's foreign keys block it too, so order history always stays intact.
- After deleting a product that was in the shop, press **Publish storefront** to remove it from the shop pages; until then its page shows sizes as unavailable.

### D42. Go-live Phase A: test site on workers.dev (28 Oct 2026)
- The new store runs first at **https://veeess-knits.info-veeessknits.workers.dev** (Cloudflare account of Veeess Knits, company email) while the old Wix site stays on veeessknits.com. Phase B moves the domain.
- Live resources: D1 `veeess_db` (APAC), R2 `veeess-media`, Turnstile widget (hostnames: the workers.dev address, veeessknits.com, www.veeessknits.com), Razorpay **test** keys and a test-mode webhook to `/api/webhooks/razorpay`. Secrets are stored with `wrangler secret put` only.
- `SITE_URL` is the workers.dev address for now (used in email links); switch to `https://www.veeessknits.com` in Phase B, together with the Razorpay webhook URL.
- **Admin login (Cloudflare Access), 28 Oct 2026:** Zero Trust Free, team `veeessknits.cloudflareaccess.com`, login by **One-time PIN** (email code). Access app **"Veeess Admin"** protects `/admin` and `/api/admin` on the workers.dev address; policy **"Veeess admins"** allows vetrivelpandiank@gmail.com and info.veeessknits@gmail.com (the 3rd admin to be added — in the policy **and** `ADMIN_EMAILS`). In Phase B, add the same two paths for `www.veeessknits.com` to this app.
- **Push alerts and auto-deploy, 28 Oct 2026:** VAPID public key in `wrangler.jsonc`, private key only as the `VAPID_PRIVATE_JWK` secret (never stored anywhere else). `GITHUB_REPO` set so "Publish storefront" can start the GitHub deploy (`GITHUB_DISPATCH_TOKEN` secret: fine-grained, this repo only, Contents read & write). GitHub Actions secrets `CLOUDFLARE_API_TOKEN` (Workers + D1 edit) and `CLOUDFLARE_ACCOUNT_ID` let every merge to `main` deploy automatically.
- Lesson: when Wrangler asks "add it on your behalf?" / "connect to the remote resource for local dev?", answer **no** — it rewrites `wrangler.jsonc` and can point local testing at the live database.

### D33. Not built yet (later phases)
- GST invoices (waiting on GST registration answer).
- Courier integration (Shiprocket etc.) — tracking numbers are typed in by the admin for now.
- Customer accounts, wishlists, coupons, reviews, product search box (the search icon opens the full catalogue).
- Sentry error tracking (Cloudflare Workers logs are on).

---

## 8. Open items for Veeess Knits (before launch)
- [ ] Real products, photos, prices, MRPs, stock, size charts.
- [ ] Shipping charge (D7) and dispatch time. ~~Return window~~ — no returns (D37).
- [ ] The 3 admin email addresses (D17, D37) and the alert inbox(es).
- [ ] Any COD maximum order value (D12) and whether to phone-confirm every COD order.
- [ ] GST registration / invoice requirement (D8).
- [ ] WhatsApp number (D28) and grievance officer for the privacy policy (D29).
- [ ] Razorpay KYC, automatic capture on, webhook configured (README §2.4).

### D43. Go-live Phase B: veeessknits.com moves to the new store (29 Oct 2026)
- Domain stays registered at Wix (renews 2 Mar 2029); its nameservers now point to Cloudflare (`ivan` / `meiling.ns.cloudflare.com`), zone on the Free plan. The old Wix DNS records were removed.
- **www.veeessknits.com** is the store (Worker custom domain). **veeessknits.com** redirects 301 to www with the path and query string kept (Redirect Rule "Root to www"). Both custom domains are also listed under `routes` in `wrangler.jsonc` so deploys keep them.
- `SITE_URL` is now `https://www.veeessknits.com` (email and order links). The workers.dev address still works for testing.
- Admin login: `www.veeessknits.com/admin` and `/api/admin` are added to the Access app "Veeess Admin". The Razorpay webhook URL moves to `https://www.veeessknits.com/api/webhooks/razorpay`.
- The old Wix site is kept at its free Wix address and is planned at **info.veeessknits.com** (CNAME from Wix, DNS only in Cloudflare; needs a Wix Premium plan to connect a subdomain).

### D44. Online payment only; footer points to the old site (29 Oct 2026)
- Cash on delivery is **off**. Customers pay online (UPI, cards, netbanking via Razorpay). Replaces the "COD at no extra charge" decision.
- Switch: `COD_ENABLED` in `wrangler.jsonc` ("0" off, "1" on). The Worker refuses a COD checkout before any database work; the checkout page no longer offers it. The admin panel still shows and handles any older COD orders.
- Wording across the site now says "Secure online payment" / "No cash on delivery" (banner, home, shop, product, cart, checkout, shipping policy, terms).
- Footer line "For more queries, visit …" links to the old Wix site, **infoveeessknits.wixsite.com/my-site-5**, until info.veeessknits.com is connected.

### D45. www.veeessknits.com goes back to the Wix portfolio; store domain decided later (30 Oct 2026)
- Supersedes the domain part of D43 and the footer part of D44. **veeessknits.com / www.veeessknits.com** = the Wix portfolio site again (Premium Core plan). Wix only connects a Wix-registered domain to a site when it uses **Wix nameservers**, so the nameservers were reset to Wix (ns12/ns13.wixdns.net); the Cloudflare zone no longer controls the domain.
- That rules out a Cloudflare subdomain (store.veeessknits.com) while the domain is registered at Wix. Options for later: transfer the registration to Cloudflare (then Wix connects by DNS records and store.veeessknits.com works), or a separate domain for the store.
- Until then the store runs on **https://veeess-knits.info-veeessknits.workers.dev** (`workers_dev: true`, no `routes`, `SITE_URL` = that address). Access app keeps the workers.dev `/admin` and `/api/admin` paths. The Razorpay test webhook must point to the workers.dev address.
- Footer "For more queries, visit www.veeessknits.com" links to the portfolio again.
