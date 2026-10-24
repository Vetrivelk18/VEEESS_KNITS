# Veeess Knits — online store

Mobile-first store for **Wordle** and **Max8** with Razorpay, cash on delivery (no extra charge) and an admin panel with instant new-order alerts. Runs on Cloudflare's free plan.

- **Storefront:** Astro static pages (`src/`), served free from Cloudflare.
- **API + admin + cron:** one Cloudflare Worker (`worker/`) with D1 (database) and R2 (photos, backups).
- **Decisions and assumptions to review:** [`docs/DECISIONS.md`](docs/DECISIONS.md).

```
src/            Storefront and admin pages (Astro), browser scripts, styles
worker/         API (Hono): checkout, payments, webhook, admin, cron jobs
  lib/          security, orders, Razorpay, push, email, validation
migrations/     D1 schema (0001) and sample catalogue (0002)
public/         Images, security headers (_headers), admin service worker
scripts/        Catalogue export, VAPID key generator, seed generator
tests/          Security unit tests (vitest)
```

---

## 1. Run it on your computer

Needs Node.js 22+.

```bash
npm install
cp .dev.vars.example .dev.vars        # local settings, never committed
npm run gen:vapid                      # paste both lines into .dev.vars
npm run db:migrate:local               # creates the local database with sample products
npm run dev                            # builds the site and starts http://localhost:8787
```

- Shop: http://localhost:8787 — checkout works offline: `RAZORPAY_MOCK=1` shows a "Simulate successful payment" panel instead of Razorpay.
- Admin: http://localhost:8787/admin/ — on localhost you are signed in as `DEV_ADMIN_EMAIL` (development only).
- Test the 15-minute job: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"`

Checks before every change:

```bash
npm run typecheck && npm test && npm run build:site
```

---

## 2. Go live (one-time setup)

Do every account step **with the company's email**, then add the developer as a member.

### 2.1 Cloudflare
1. Create a Cloudflare account, add the domain `veeessknits.com` and switch its nameservers to Cloudflare. Turn on **auto-renew** and **registrar lock** at the registrar.
2. Create the database and storage:
   ```bash
   npx wrangler login
   npx wrangler d1 create veeess_db          # copy the database_id into wrangler.jsonc
   npx wrangler r2 bucket create veeess-media
   ```
3. Edit `wrangler.jsonc` → `vars`: `SITE_URL`, `ADMIN_EMAILS` (the 2–3 admins), `ALERT_EMAIL_TO`, `RAZORPAY_KEY_ID`, `TURNSTILE_SITE_KEY`, `VAPID_PUBLIC_KEY`, `GITHUB_REPO`.
4. Add a **custom domain** to the Worker (Workers → veeess-knits → Settings → Domains): `www.veeessknits.com`, plus a redirect from the bare domain.

### 2.2 Secrets (never in code)
```bash
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put ORDER_LINK_SECRET        # any random 40+ characters: openssl rand -base64 48
npx wrangler secret put VAPID_PRIVATE_JWK        # from npm run gen:vapid
npx wrangler secret put RESEND_API_KEY           # optional but recommended (order emails)
npx wrangler secret put GITHUB_DISPATCH_TOKEN    # fine-grained token: this repo only, "Contents: read & write"
```
The app refuses to take payments if a Razorpay secret is missing or still a placeholder.

### 2.3 Admin login — Cloudflare Access (free up to 50 users)
1. Zero Trust → Access → Applications → **Add self-hosted application**.
2. Domain `www.veeessknits.com`, paths **`/admin`** and **`/api/admin`** (add both).
3. Policy: **Allow** → Emails → the 2–3 admin emails. Login method: **One-time PIN**.
4. Copy the application's **AUD tag** into `ACCESS_AUD` and your team domain (e.g. `veeess.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`.

The Worker also verifies the Access token itself and checks `ADMIN_EMAILS`, so a mistake in Access does not open the admin panel.

### 2.4 Razorpay
1. Complete KYC in the company's name (see the HLD for documents).
2. **Settings → Payment capture → Automatic.** (Only captured payments mark orders paid.)
3. **Settings → Webhooks → Add:** URL `https://www.veeessknits.com/api/webhooks/razorpay`, a strong secret (same as `RAZORPAY_WEBHOOK_SECRET`), events **payment.captured**, **order.paid**, **payment.failed**, **refund.processed**.
4. Start with **test keys**, run the checklist below, then switch `RAZORPAY_KEY_ID` and the secret to **live keys**.

### 2.5 Turnstile (bot protection)
Cloudflare → Turnstile → Add widget for `www.veeessknits.com` (Managed). Put the site key in `TURNSTILE_SITE_KEY` and the secret in `TURNSTILE_SECRET_KEY`.

### 2.6 Firewall rate limit (free plan: 1 rule)
Security → WAF → Rate limiting rules → create:
- If: URI Path equals `/api/checkout` and Method equals `POST`
- Rate: **20 requests per 1 minute per IP** → Action **Block** for 10 minutes.

Also turn on **Bot Fight Mode**, but add a WAF **Skip** rule for URI Path `/api/webhooks/razorpay` so Razorpay is never blocked.

### 2.7 GitHub Actions deploys
Repository secrets: `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" + D1 edit) and `CLOUDFLARE_ACCOUNT_ID`. Every push to `main` — and every **Publish storefront** click in the admin panel — tests, migrates, rebuilds the catalogue pages and deploys.

### 2.8 Email (optional, recommended)
Create a free Resend account, verify the domain, set `EMAIL_FROM` and `RESEND_API_KEY`. Without it, orders still work and admins still get in-panel and push alerts, but no emails are sent.

### 2.9 Monitoring
- UptimeRobot (free): monitor `https://www.veeessknits.com/`, a product page, and `https://www.veeessknits.com/api/health` every 5 minutes, alerting the directors.
- Workers → Logs (enabled via `observability`) shows errors; optional Sentry later.

---

## 3. Before launch — test checklist (Razorpay test mode)
- [ ] Online order: UPI success, card success, payment failure, closing the payment window, paying again.
- [ ] COD order: arrives as "COD to confirm" with no extra charge; third open COD order from the same phone is refused.
- [ ] New-order alert: bell + chime in the panel, push on every admin phone/laptop, backup email, re-alert after 15 minutes unread.
- [ ] Webhook: Razorpay dashboard → webhook → "Test" shows 200; a duplicate is ignored.
- [ ] Refund from the admin panel shows in Razorpay; stock goes back.
- [ ] Last-item race: two browsers buy the final unit — one succeeds, one gets "just sold out".
- [ ] Admin URLs return 401 in a private window that hasn't signed in.
- [ ] securityheaders.com grade A; SSL Labs grade A.
- [ ] Load test with k6: 50 shoppers + 3 admins for 10 minutes; no errors.
- [ ] Replace sample products, prices, photos and the bracketed policy text.

## 4. Emergency runbook
| Problem | Do this |
| --- | --- |
| Site broken after a change | Cloudflare → Workers → veeess-knits → Deployments → **Rollback** to the previous version. |
| Payments failing | Check Razorpay status page and dashboard; customers can still choose COD. |
| Suspected key leak | Regenerate the key in Razorpay / Cloudflare, `wrangler secret put` the new value. Old one stops working immediately. |
| Wrong data / accidental deletion | D1 → Time Travel → restore to a time before the problem; weekly JSON backups are also in R2 under `backups/`. |
| Admin locked out | Another admin signs in; or add their email in Access and `ADMIN_EMAILS`. |
