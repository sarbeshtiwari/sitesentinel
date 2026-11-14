# SiteSentinel — UI/UX design system

The customer app (`apps/web`) and the Super Admin console (`apps/admin`) share one design system. It lives in the
`@wim/ui` package (`packages/ui`):

| Layer | File |
|---|---|
| Tokens (CSS variables, Tailwind theme mapping, dark mode, reduced motion) | `packages/ui/src/styles.css` |
| Primitives: buttons, inputs, cards, badges, status, alerts, states, page header, metric cards, breadcrumbs, tooltip, avatar, filter bar, pagination, tables | `packages/ui/src/components/primitives.tsx` |
| Overlays: dialog, confirm dialog, drawer, dropdown menu, tabs | `packages/ui/src/components/overlays.tsx` |
| Application shell: sidebar, topbar, mobile drawer, theme toggle, auth layout | `packages/ui/src/components/layout.tsx` |
| Logo components | `packages/ui/src/components/brand.tsx` |
| Monitoring-specific building blocks (customer app): health badges, query states, range picker, filters, charts, sections | `apps/web/src/components/monitoring.tsx` |

Never add a second component system. New shared UI goes into `@wim/ui`; monitoring-only widgets go into
`apps/web/src/components/monitoring.tsx`.

---

## 1. Brand

**Concept.** A *sentinel*: a shield-shaped tile (protection, a watch post) holding an open aperture — the eye that
watches — with a cyan *signal* core (the live check). It deliberately avoids the generic "shield with a checkmark":
SiteSentinel observes and reports, it doesn't promise that everything is fine.

**Assets** (identical copies in `apps/web/public` and `apps/admin/public`):

| Asset | Path | Use |
|---|---|---|
| Full logo | `brand/logo.svg` | Light backgrounds |
| Full logo, dark background | `brand/logo-dark-bg.svg` | Navy / dark surfaces |
| Monochrome logo | `brand/logo-mono.svg` | Single-colour print, embossing (`currentColor`) |
| Symbol | `brand/symbol.svg` | Collapsed navigation, avatars, small spaces |
| Symbol, dark background | `brand/symbol-dark-bg.svg` | Dark surfaces |
| Symbol, monochrome | `brand/symbol-mono.svg` | `currentColor`, knocked-out aperture |
| Admin symbol | `brand/symbol-admin.svg` | Super Admin console (navy tile) |
| Social preview | `brand/og-image.png` (1200×630) | Open Graph / Twitter cards |
| Favicon | `favicon/favicon.svg`, `favicon-16/32/48.png`, `apple-touch-icon.png`, `site.webmanifest` | Browsers, home screens |
| App icons | `icons/icon.svg`, `icon-192.png`, `icon-512.png` | PWA manifest |

The symbol is drawn on a 32-unit grid with a 1.5-unit safe margin and was checked at 16, 24, 32, 48 and 128 px.
The PNGs are rendered from the SVG sources (the aperture, pupil and core stay distinct at 16 px).

**In code** use the components, not `<img>`, so the mark follows the runtime brand colour and theme:

```tsx
import { Logo, LogoSymbol } from "@wim/ui";
<Logo name={config.productName} />            // symbol + wordmark
<LogoSymbol />                                  // symbol only (follows --brand)
<LogoSymbol variant="admin" />                  // navy control-plane mark
<LogoSymbol variant="mono" className="text-foreground" />
```

**Usage rules**

- Clear space around the logo ≥ the height of the aperture (¼ of the symbol height).
- Minimum sizes: symbol 16 px, full logo 96 px wide.
- Don't recolour the aperture or the core, add effects, rotate, outline or place the full-colour logo on busy imagery.
- The wordmark is "Site" (medium) + "Sentinel" (bold), Instrument Sans, tracking −2 %.
- White-label: `branding.productName` replaces the wordmark text, `branding.logoUrl` (https only) replaces the whole
  logo, `branding.primaryColor` re-tints the tile and every primary surface, `branding.faviconUrl` replaces the
  favicon at runtime.

## 2. Colour

All colours are CSS variables on `:root`, redefined for dark mode both under
`@media (prefers-color-scheme: dark)` (when the viewer hasn't chosen) and `:root[data-theme="dark"]` (explicit
choice, stored per viewer in `localStorage`). Tailwind utilities map to them (`bg-card`, `text-muted-foreground`, …).

| Token | Light | Dark | Utility | Role |
|---|---|---|---|---|
| `--brand` | `#4F46E5` | — | — | Primary brand (runtime-overridable) |
| `--brand-accent` | `#06B6D4` | — | `text-accent` | Signal accent, used sparingly |
| `--navy` | `#101828` | — | `bg-navy` | Admin chrome, tooltips, brand panels |
| `--background` | `#F7F8FC` | `#0B1020` | `bg-background` | App canvas |
| `--card` | `#FFFFFF` | `#121829` | `bg-card` | Surfaces |
| `--surface-sunken` | `#F1F3F9` | `#0E1424` | `bg-sunken` | Table headers, footers, segmented controls |
| `--muted` | `#EEF0F6` | `#1A2135` | `bg-muted` | Hover fills, neutral chips |
| `--foreground` | `#182230` | `#E7EAF2` | `text-foreground` | Body text |
| `--muted-foreground` | `#667085` | `#9AA4B8` | `text-muted-foreground` | Secondary text |
| `--subtle-foreground` | `#98A2B3` | `#6B7489` | `text-subtle-foreground` | Placeholders, tertiary |
| `--border` / `--border-strong` | `#E4E7EF` / `#D0D5E1` | `#232B40` / `#2F3850` | `border-border(-strong)` | Dividers / inputs |
| `--primary` | `= --brand` | brand lightened 18 % | `bg-primary`, `text-primary` | Actions, links, focus |
| `--primary-soft` | brand 10 % | brand 22 % | `bg-primary-soft` | Selected nav item, icon chips |
| `--success` | `#16A34A` | `#22C55E` | `text-success` | Healthy, passed, resolved |
| `--warning` | `#D97706` | `#F59E0B` | `text-warning` | Degraded, needs attention |
| `--danger` | `#DC2626` | `#F05252` | `text-danger` | Down, failed, destructive |
| `--info` | `#0891B2` | `#22D3EE` | `text-info` | Informational, admin role chips |

**Status colour rules.** Colour never carries meaning alone — every status also has a text label (Badge,
HealthBadge, StatusIndicator) or an icon. "Inconclusive", "No data" and "Disabled" are *neutral*, never green: an
absence of data is not health. Soft status backgrounds are derived with `color-mix` (10–12 %) so they work in both
themes.

## 3. Typography

| | Family | Source |
|---|---|---|
| Sans (UI + display) | Instrument Sans (variable, 400–700) | Self-hosted `apps/*/src/app/fonts/` via `next/font/local` |
| Mono (codes, ids, DNS records) | JetBrains Mono (variable) | Self-hosted, same |

Fonts are self-hosted (SIL OFL, licence beside the files) so the CSP stays `font-src 'self'` and builds need no
network. System stacks are the fallback.

| Style | Size / weight | Where |
|---|---|---|
| Page title | 22–24 px / 600, tracking −1 % | `PageHeader` |
| Hero title | 20 px / 600 | Overview status |
| Section title | 15 px / 600 | `Section`, `CardTitle` |
| Body | 14 px / 400 | Default |
| Small / meta | 12–13 px | Hints, secondary lines |
| Table header | 11 px / 600, uppercase, +6 % tracking | `TH` only |
| Metric | 26 px / 600, tabular | `MetricCard` |

Numbers in tables and metrics always use `tabular-nums`.

## 4. Spacing, radius, elevation, layout

- **Spacing** follows the Tailwind 4 px scale. Page sections are separated by `gap-5` (20 px); card padding is
  16 px (mobile) / 20 px (≥ sm); table cells 12 px vertical.
- **Radius**: `rounded-sm` 6 px (chips), `rounded-md` 8 px (controls), `rounded-lg` 12 px (cards), `rounded-xl` 16 px
  (dialogs, hero tiles).
- **Elevation**: `shadow-xs` resting cards and controls, `shadow-sm` hover on interactive cards, `shadow-md`
  tooltips, `shadow-lg` menus, dialogs and drawers. Dark mode uses deeper, darker shadows.
- **Containers**: content max width 1320 px (customer), 1600 px (admin, dense data); side padding 16 / 24 / 32 px.
- **Breakpoints** (Tailwind defaults): `sm` 640, `md` 768, `lg` 1024 (sidebar becomes fixed), `xl` 1280.

## 5. Components

| Component | Notes |
|---|---|
| `Button` | Variants `primary`, `secondary`, `outline`, `ghost`, `danger`, `link`; sizes `sm`, `md`, `lg`, `icon`. `loading` shows a spinner and disables. Use one primary action per view. |
| `Input`, `Select`, `Textarea`, `Checkbox` | Shared field style: 36 px high, focus ring 3 px brand at 22 %, `aria-invalid` turns the border red. |
| `FormField` | Label + control + hint or error (`role="alert"`, icon). Wire `aria-describedby` on the control. |
| `Card` family | Surface, header, title, description, content, footer (sunken). |
| `Section` (web) | Card with optional icon, title, description, actions; `flush` for tables/lists. |
| `MetricCard` | Label, value, optional icon chip with tone, hint, optional link. Values must come from the API. |
| `Badge` | Tones `neutral`, `brand`, `success`, `warning`, `danger`, `info`; soft fill + inset ring. |
| `StatusIndicator` / `HealthBadge` / `Dot` | Status with a label; `HealthBadge` maps monitoring states to one vocabulary (`lib/monitoring.ts` `HEALTH`). |
| `Alert` | Inline message with icon; `danger` uses `role="alert"`. |
| `Skeleton`, `Spinner` | Loading. Pages use `QueryState` which shows a skeleton, 403/404 messages or `ErrorState` with retry. |
| `EmptyState` | Icon chip, title, one sentence, optional action (only when the viewer may act). |
| `ErrorState` | What failed + "Try again" when retry is possible. |
| `PageHeader` | Optional eyebrow, title (h1), description, actions. |
| `Breadcrumbs` | Derived from the URL in the shells (no extra requests); ids shown by record type. |
| `Tooltip` | CSS-only, appears on hover **and** keyboard focus; never the only place important info lives. |
| `Dialog`, `ConfirmDialog`, `Drawer` | Native `<dialog>`: focus trap, Esc, inert background. Destructive confirms use the `danger` button and say what will happen. |
| `DropdownMenu` | Menu button pattern, arrow-key navigation, Esc and outside-click close. |
| `Tabs` (segmented) / website tab bar | `role="tablist"`; scroll horizontally on small screens. |
| `Table` family | Sunken header, row hover, horizontal scroll inside its card. Dense lists switch to stacked cards below `md`. |
| `FilterBar`, `FilterSelect`, `Pagination`, `LoadMore` | Filters wrap on mobile; cursor pagination. |
| Charts (`StackedBars`, `LineChart`, `Distribution`) | Dependency-free SVG fed by API aggregates. Gaps (no data) are drawn hatched or as breaks — never as "up". Each has an `aria-label`. |
| Toasts | `sonner` (`toast.success/error`), bottom-right. |

## 6. Navigation

**Customer app** — sidebar groups:

- *Monitor*: Overview, Websites, Incidents, History
- *Workspace*: Notifications (unread count), Usage & limits
- *Organization*: General, Team, Roles, Audit log
- *Account* (only when no organization is open; otherwise in the user menu)

Items are shown only when the member's role grants the permission the page needs (`website:read`, `incident:read`,
`member:read`, `audit:read`, `org:read`); the API enforces the same permissions. Unreleased sections (API monitoring)
are not linked. Topbar: workspace (organization) switcher, breadcrumbs, help (only if a support e-mail is configured),
notifications, theme, user menu.

**Super Admin** — navy control-plane chrome (`surface="admin"`), "Admin" marker in the logo and a *Super Admin*
chip in the topbar so it can't be mistaken for the customer app. Groups *Platform* and *Operations*, each item gated
by the administrator's role (`me.can(...)`). It remains aggregate-only: no customer credentials, content, telemetry
or incident details.

**Collapse**: on ≥ lg the sidebar collapses to a 68 px icon rail; labels move into tooltips (hover and focus) and
the state is remembered per viewer. **Mobile** (< lg): the sidebar becomes a drawer (focus moves in, Esc closes,
focus returns to the menu button, body scroll locks).

## 7. Responsive behaviour

- No horizontal page scroll at any width (the E2E suite checks 390 px).
- Metric grids: 2 columns on mobile → 4 on lg. Overview hero stats stay a 3-up strip.
- Dense tables (websites, incidents) render as stacked cards below `md`; secondary columns appear progressively
  (`lg`, `xl`).
- Page actions wrap under the title on small screens; the time-range picker scrolls if needed.
- Auth screens: a single form column on mobile; a brand panel is added on ≥ lg.

## 8. Accessibility

- Skip link to `#main`; landmarks (`nav` with labels, `main`, `header`).
- Visible focus ring on every interactive element (`:focus-visible`, 2 px brand).
- Contrast: body and secondary text meet WCAG AA on both themes; status is never colour-only.
- Icon-only buttons have `aria-label`; decorative icons are `aria-hidden`.
- Forms: labels bound to inputs, errors announced (`role="alert"`) and linked.
- Menus, dialogs, drawers and tabs follow the WAI-ARIA patterns (keyboard, Esc, focus return).
- `prefers-reduced-motion: reduce` removes transitions and animations globally; motion elsewhere is limited to short
  (≤ 200 ms) state transitions.
- Theme: system preference by default, explicit choice stored per viewer, applied before first paint (no flash).

## 9. Content rules

- Real data only. No sample numbers, illustrative charts or placeholder metrics anywhere in the product UI.
- Browser and performance measurements are **synthetic** (our Chromium runners), never described as real-user data.
- Say what failed and what to do next. Distinguish *your website is down* from *our check was inconclusive*.
- Times are shown in UTC and labelled as such.
