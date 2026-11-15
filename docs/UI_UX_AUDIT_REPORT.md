# SiteSentinel — UI/UX & brand audit (local running apps)

Date: 2026-11-15 · Branch `stage` · Customer app http://localhost:3000, Super Admin http://localhost:3001 (Next dev servers, hot reload, not restarted).
Logins: review customer (`REVIEW_EMAIL`/`REVIEW_PASSWORD`, orgs `REVIEW_ORG`, `REVIEW_ORG2`, site `REVIEW_SITE`, incident `REVIEW_INCIDENT`) and admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_TOTP_SECRET`, one TOTP sign-in per viewport context). No secrets in this report.

Method: Playwright (`@playwright/test` resolved from `tests/e2e`, same as `scripts/visual/capture.mjs`), scripts in the session scratchpad (not the repo). Per page: HTTP status, final URL, console errors/warnings + `pageerror`, failed requests (requestfailed + HTTP >= 400), Google-Fonts requests, `scrollWidth - innerWidth`, broken `<img>` (naturalWidth 0), `href="#"`/empty/`javascript:` links, computed-style WCAG contrast scan of every visible text node (alpha-composited background), full-page screenshot. Plus scripted interaction checks (keyboard focus walk, sidebar, menus, dialogs, drawer, tabs, filters, error states via route interception, skeleton via delayed response) and an internal-link 404 sweep.

Totals: **583 page loads** recorded (68 routes × 4 viewports + dark-mode passes + post-fix re-checks), 337 screenshots.

Caveat: the API's login rate limit (`auth.login.perIpPer15Min`) returned **429** after repeated sign-ins; I switched to one saved session (scratchpad storage state, deleted afterwards). Not a product defect — expected protection.

---

## 1. Route inventory & per-viewport status

Legend: `OK` = rendered, HTTP as shown, no console errors, no failed requests (except expected), no horizontal overflow, no broken images. Viewports: 1440×900 / 1280×800 / 768×1024 / 390×844.

### Customer app — auth (signed out)
| Route | 1440 | 1280 | 768 | 390 | Notes |
|---|---|---|---|---|---|
| /login | OK | OK | OK | OK | brand panel ≥ lg, single column on mobile |
| /register | OK | OK | OK | OK | |
| /forgot-password | OK | OK | OK | OK | |
| /reset-password?token=x | OK | OK | OK | OK | |
| /verify-email?token=x | OK | OK | OK | OK | expected 400 from verify API with dummy token, shown as error |
| /2fa | OK | OK | OK | OK | expected 401 on `/auth/2fa/reset` without session |
| /2fa-reset/confirm, /2fa-reset/cancel | OK | OK | OK | OK | |
| /invitations/accept?token=x | OK | OK | OK | OK | expected 401 `/me` |
| / (anon) | → /login?next=%2F | same | same | same | |
| /no-such-page | 404 branded page | 404 | 404 | 404 | |

### Customer app — signed in
| Route | 1440 | 1280 | 768 | 390 |
|---|---|---|---|---|
| / → /o/ORG2/overview | OK | OK | OK | OK |
| /onboarding | OK* | OK | OK | OK |
| /o/ORG1/overview | OK* | OK | OK | OK |
| /o/ORG1/websites | OK* | OK | OK | OK |
| /o/ORG1/websites/new | OK* | OK | OK | OK |
| /o/ORG1/websites/transfers | OK* | OK | OK | OK |
| website `?tab=` overview, availability, performance, browser, pages, components, responsive, deep-scan, monitoring-settings, verification, installation, settings, history, audit (14 tabs) | OK | OK | OK | OK |
| …/deep-scan/scans/:executionId | OK | OK | OK | OK |
| …/deep-scan/findings/:findingId | OK | OK | OK | OK |
| …/browser/:executionId (browser run) | OK | OK | OK | OK |
| /o/ORG2/incidents, /o/ORG2/incidents/:id, /o/ORG2/history | OK | OK | OK | OK |
| /o/ORG1/notifications, /notifications/preferences | OK | OK | OK | OK |
| /o/ORG1/usage | OK | OK | OK | OK |
| /o/ORG1/analytics | redirects to overview by design (`redirect()` in page) | | | |
| /o/ORG1/api-monitoring | OK — honest "Not released yet" empty state, not linked in nav | | | |
| settings: general, team, roles, audit, billing | OK | OK | OK | OK |
| /account/profile, /account/security | OK | OK | OK | OK |
| /o/ORG1/no-such-page | 404 page | 404 | 404 | 404 |
| /o/ORG1/websites/<unknown uuid> | "Website not found" warning inside shell | same | same | same |

`*` = one-off hydration error, see issue #1 (not reproducible in 3 later runs).

### Super Admin
| Route | 1440 | 1280 | 768 | 390 |
|---|---|---|---|---|
| /login | OK | OK | OK | OK |
| / → /overview | OK | OK | OK | OK |
| /overview, /platform, /alerts, /monitoring, /usage, /operations, /customers, /websites, /transfers, /plans, /gateways, /settings, /audit, /account | OK | OK | OK | OK |
| /no-such-page | 404 page | 404 | 404 | 404 |

Horizontal page overflow: **0 pages at any viewport** (scrollWidth − innerWidth ≤ 1 everywhere, light and dark).
Broken images: **0**. Dead links (`href="#"`, empty, `javascript:`): **0**. Internal-link sweep: 69 distinct customer links found on visited pages → all < 400; 13 admin links all map to routes visited with 200.

## 2. Brand checklist
| Item | Result |
|---|---|
| Brand assets in `public/brand` (logo, logo-dark-bg, logo-mono, symbol, symbol-dark-bg, symbol-mono, symbol-admin, og-image 1200×630) — identical in web & admin | PASS (files present, byte-identical sets) |
| Favicon `<link rel=icon>`: `/favicon/favicon.svg`, `-32.png`, `-16.png`, apple-touch-icon, `site.webmanifest`, `/icons/icon-192/512.png` | PASS — all 200 with correct content types on both apps. `/favicon.ico` 404 (not referenced; browsers use the declared icons) |
| Title / description / OG / Twitter tags | PASS — "SiteSentinel" / "SiteSentinel Admin". **Fixed**: no `metadataBase`, so og:image would resolve to `http://localhost:<port>` in production (issue #6) |
| Fonts self-hosted, no Google Fonts requests | PASS — `next/font/local` (Instrument Sans, JetBrains Mono); 0 requests to fonts.googleapis/gstatic across 583 loads |
| No default Next/Vercel branding | PASS — only the dev-only Next indicator ("N" bubble, ignored) |
| Logo crisp at small sizes | PASS — SVG symbol in sidebar/collapsed rail/auth/404; PNG favicons rendered from SVG at 16/32/48 |
| Admin distinct (navy chrome, "ADMIN" marker, "Super Admin" chip) | PASS |

## 3. Shell checklist (customer unless noted)
| Item | Result |
|---|---|
| Skip link is first Tab stop, visible | PASS ("Skip to content", 2 px outline) |
| Sidebar groups Monitor / Workspace / Settings (collapsible) | PASS; Settings group `aria-expanded` false→true on click; auto-opens when it holds the active page |
| Active state (`aria-current=page`, card style) | PASS |
| Collapse to icon rail (≥ lg) | PASS: 260 px → 72 px, persisted after reload |
| Collapsed tooltips | PASS on hover (visible, opacity 1); keyboard-focus tooltip present in CSS (`group-focus-visible`) — runtime keyboard check was inconclusive in my script (PARTIAL) |
| Topbar: workspace switcher, breadcrumbs, notifications (unread badge + aria-label), theme toggle | PASS — breadcrumbs "Websites › Website › Deep scan › Finding"; theme toggle system→dark and back |
| Workspace selector (DropdownMenu) | PASS — opens, first item focused (bg highlight), ArrowDown moves focus, Esc closes and returns focus to trigger |
| Account menu (bottom of sidebar) | PASS — Profile / Security / Sign-in activity / Sign out; outside click closes. Admin: My account / Sign out |
| Mobile drawer (< lg) | PASS — opens as `role=dialog`, focus moves in, body scroll locked, Esc closes and focus returns to "Open navigation", navigating closes it. Admin drawer same |
| Keyboard focus visibility | PASS — 25-stop Tab walks on overview, websites, website, incidents, general (customer) and admin overview: every focused control had a visible ring (only misses were Next's dev overlay `nextjs-portal`, dev-only) |

## 4. Component checklist
| Component | Result |
|---|---|
| Dialog (admin Plans → Edit details) | PASS — native `<dialog>`, focus inside, focus stays inside after 15 Tabs, Esc closes and returns focus to "Edit details", Cancel closes |
| ConfirmDialog | Code path same `<dialog>`; not opened at runtime (all triggers on review data are destructive) — PARTIAL |
| Dropdowns (keyboard arrows, Esc, outside click) | PASS |
| Website tabs (`role=tablist`, 14 tabs, ArrowRight moves + updates `?tab=`) | PASS; tab bar scrolls horizontally on 768/390 |
| Tables (sunken header, horizontal scroll inside card) | PASS; admin Plans/Customers layout issues fixed (#7, #8) |
| Filters (incidents status select → `?status=OPEN`) | PASS |
| Pagination / Load more (incidents, admin customers) | PASS (button present, admin customers loads next page) |
| Charts (SVG LCP line, admin signups bars) | PASS — gaps shown as gaps ("2 of 169 buckets have measurements") |
| Toasts (sonner) | Present in code; copy buttons use inline "Copied" state instead of a toast (fine). Not triggered at runtime without a mutating action — PARTIAL |
| Skeleton | PASS — delayed overview API shows skeleton (`role=status`) |
| Empty states | PASS — api-monitoring, invoices, "Nothing changed in this range", no-match |
| Error states via route interception (HTTP 500) | overview, usage, incidents, incident detail, notifications, audit, deep-scan tab: `ErrorState` + "Try again". **Fixed**: websites list and website detail showed a bare red alert without retry (#4, #5). Admin pages show an `Alert` without retry (auto-refresh every minute) — Low, not changed |
| Status colours vs docs | PASS — Inconclusive / No data / Not available render neutral grey (never green); outage red, degraded amber, healthy green, all with text labels |
| Fake / hardcoded data | PASS — no sample numbers in pages (grep for random/mock/sample/lorem; values come from API). Plan prices are seeded placeholders and are labelled "Example prices … decision B2" in both admin and customer billing (seed data, out of UI scope) |

## 5. Issue table
| # | Page | Viewport | Issue | Severity | Fixed | File |
|---|---|---|---|---|---|---|
| 1 | onboarding, overview, websites, websites/new, transfers | 1440 (first run only) | React "Hydration failed…" pageerror + follow-on "Encountered a script tag while rendering React component" (theme `<script>` re-rendered on the client during hydration recovery). Did not reproduce in 3 later passes (fresh contexts, light & dark) — consistent with a dev-server HMR rebuild while another engineer was editing. Watch in prod build | Low (transient, dev) | n | apps/web/src/app/layout.tsx |
| 2 | Status badges everywhere (Verified, Included, Open, Partial, ok/attention/healthy…) | all | Badge text used the raw status colour on its 10–12 % tint: 2.8–4.1 : 1 (fails WCAG AA at 12 px), contradicting docs §8 | Medium | **y** — new `--{success,warning,danger,info}-text` tokens (darkened in light, lighter danger in dark); re-scan: 0 badge failures | packages/ui/src/styles.css, packages/ui/src/components/primitives.tsx |
| 3 | Secondary text on muted/sunken fills (chips, segmented control "7d", table meta) and the range-picker zone label "GMT+5:30" | all | `--muted-foreground #667085` = 4.37–4.48 : 1 on `--muted`/`--surface-sunken`; zone label used `--subtle-foreground` (2.4 : 1) | Medium | **y** — muted-foreground `#5E6A7E` (≥ 4.7 : 1 on all light surfaces); zone label → muted-foreground | packages/ui/src/styles.css, apps/web/src/components/monitoring.tsx, docs/UI_UX_DESIGN_SYSTEM.md |
| 4 | Website detail, API error | all | Non-404 failure showed a bare red alert with no retry (every other page uses `ErrorState` + "Try again") | Low | **y** (verified: retry button present) | apps/web/src/app/(app)/o/[orgId]/websites/[websiteId]/page.tsx |
| 5 | Websites list, API error | all | Same as #4 | Low | **y** (verified: retry recovers list) | apps/web/src/app/(app)/o/[orgId]/websites/page.tsx |
| 6 | All pages (metadata) | — | No `metadataBase`: og:image / twitter:image become `http://localhost:<port>/brand/og-image.png` in a production build | Medium | **y** — from `APP_URL` / `ADMIN_URL` (documented required env), undefined-safe | apps/web/src/app/layout.tsx, apps/admin/src/app/layout.tsx |
| 7 | Admin Plans | 1280, 1440 | Price table's last column ("Deactivate") clipped at the card edge; gateway cell wrapped "Stripe — · / Razorpay —" awkwardly | Low | **y** — gateways on two lines, no-wrap | apps/admin/src/app/(admin)/plans/page.tsx |
| 8 | Admin Customers | 390, 768 | Organization names/slugs broke one word per line and trial date overflowed its cell | Low | **y** — min width for name column, trial cell no-wrap (table scrolls inside its card) | apps/admin/src/app/(admin)/customers/page.tsx |
| 9 | Website overview, verification, installation, history, transfers | all | Times shown with `toLocaleString()` ("11/14/2026, 4:29:33 AM", no zone) while the rest of the product uses "2026-11-14 04:29 GMT+5:30" (docs §9 "labelled") | Low | **y** — `fmt`/`fmtDate` reuse `fmtTime`/`localDay` (verified on verification tab) | apps/web/src/lib/websites.ts |
| 10 | Dark mode — primary buttons, links, danger button | dark | White on `--primary` (brand 82 % + white) 4.37 : 1; primary links on dark cards 4.05 : 1; white on dark `--danger` 3.48 : 1 | Medium | **y** — dark `--primary` brand 75 % + white (links ≥ 4.7 : 1); new `--primary-solid` / `--danger-solid` for button fills (≥ 4.8 : 1); dark re-scan of 10 key pages: 0 contrast failures | packages/ui/src/styles.css, primitives.tsx, docs |
| 11 | Admin Usage/Websites charts, admin Platform status chips | 1440 | A few hand-rolled labels still use raw `text-success`/`text-warning` on white/tint (e.g. recharts legend "Verified" 3.3 : 1) | Low | n | apps/admin/src/app/(admin)/websites/page.tsx, platform/page.tsx |
| 12 | Admin pages error state | all | API failure shows `Alert` without retry (page auto-refreshes) — inconsistent with customer `ErrorState` | Low | n | apps/admin/src/app/(admin)/* |
| 13 | Unknown website id | all | Page also fires `/monitoring/schedule` for the unknown id (extra 404 request) | Low | n | apps/web/src/app/(app)/o/[orgId]/websites/[websiteId]/page.tsx |
| 14 | `/favicon.ico` | — | 404 (no file); declared icons work, but some crawlers/clients request it blindly | Info | n | apps/*/public |

Post-fix verification: `npx tsc --noEmit -p .` clean in apps/web and apps/admin; re-crawl of 14 customer pages (light), 10 customer pages (dark), 16 admin routes (light) → 0 console errors, 0 overflow, contrast failures 0 except the admin chart legend (#11). E2E text check: no changed visible string is asserted in tests/e2e (the `"Couldn't load this data"` assertion in phase4f is untouched).

## 6. Files changed (uncommitted)
- packages/ui/src/styles.css — muted-foreground, status `-text` tokens, `--primary-solid`/`--danger-solid`, dark primary
- packages/ui/src/components/primitives.tsx — Badge tones use `-text`; Button primary/danger use solid tokens
- apps/web/src/app/layout.tsx, apps/admin/src/app/layout.tsx — `metadataBase`
- apps/web/src/components/monitoring.tsx — zone label colour
- apps/web/src/lib/websites.ts — consistent labelled time format
- apps/web/src/app/(app)/o/[orgId]/websites/page.tsx, …/websites/[websiteId]/page.tsx — `ErrorState` with retry
- apps/admin/src/app/(admin)/plans/page.tsx, customers/page.tsx — table layout
- docs/UI_UX_DESIGN_SYSTEM.md — token table updated
(Other diffs in apps/api, apps/worker-deepscan, packages/db belong to another engineer and were not touched.)

## 7. Screenshots index
Directory: `<audit scratch>`
- `web-<vp>-<route>.png` — customer routes, vp ∈ d1440, l1280, t768, m390 (204 files; pre-fix pass, later passes overwrite the re-checked ones)
- `adm-<vp>-<route>.png` — admin routes (68)
- `dark-web-<vp>-*.png`, `dark-adm-<vp>-*.png` — dark mode (38)
- `ix-*.png` — interactions: sidebar collapsed/tooltip/settings group, workspace menu, account menu, theme toggle, mobile drawer, incidents filtered, skeleton, error states (`ix-error-*.png`, `ix-error-websites-after-fix.png`, `ix-admin-error-overview.png`), admin dialog, admin plans and customers after fix
Note: in full-page screenshots the fixed sidebar ends at the viewport height — capture artifact, not a layout bug.

## 8. Verdict
**Yes — it reads as one cohesive product.** Customer and Super Admin share one token set, type scale, components, logo system and shell; admin is deliberately distinct (navy chrome, ADMIN marker) without looking like a different product. Every route renders at all four widths with no page-level horizontal scroll, no broken assets, no dead links, self-hosted fonts and correct favicons. Status vocabulary is consistent and honest (inconclusive ≠ healthy; unreleased features say so). The main real defects were accessibility contrast in badges/secondary text/dark-mode buttons and a few inconsistencies (unlabelled times, missing retry, OG URL base, two admin table layouts) — all fixed with token/markup-level changes. Remaining items are Low (#1 transient dev hydration error to watch, #11–#14).
