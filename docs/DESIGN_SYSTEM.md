# Quiet Archive Design System

Quiet Archive is calm, editorial, warm, and trustworthy: closer to a modern reading room than a generic SaaS dashboard. It must not use glassmorphism, blurred floating cards, purple-blue gradients, stock hero photos, emoji icons, or default Tailwind blue.

## Tokens

Tokens are implemented as CSS variables in `/web/src/styles.css` and exposed to Tailwind through `/web/tailwind.config.ts` plus Tailwind v4 `@theme` variables.

| Token | Light | Dark wallboard |
|---|---|---|
| Paper | `#F4F0E7` | `#0F1714` |
| Paper 2 | `#EBE5D8` | `#101A16` |
| Surface | `#FBF9F4` | `#16211D` |
| Surface 2 | tonal use | `#1D2B26` |
| Ink | `#15211C` | `#E8E4D8` |
| Ink 2 | `#4A5650` | `#9AA79F` |
| Line | `#D9D2C2` | `#2A3A34` |
| Accent | forest `#1F4D3A` | `#6FB38F` |
| Accent ink | `#F4F0E7` | `#0F1714` |
| Brass | `#B07A1E` | `#D9A441` |
| Status | ok `#2E7D5B`, warn `#B7791F`, danger `#B3372B`, info `#2F5D8A` | ok `#5FBF8F`, warn `#E0A640`, danger `#E5675A`, info `#7EA8D6` |

Typography is self-hosted through `@fontsource`: display uses Fraunces with Noto Serif SC; UI uses Inter with Noto Sans SC; data and call numbers use JetBrains Mono. The scale is 12, 14, 16, 20, 28, 40, and 64. Tables and dashboard numbers use tabular numerals.

Spacing follows a 4/8 grid. Controls use 6px radius; cards and panels use 14px radius. Borders are 1px. Focus rings are 2px brass with 2px offset. Motion is 150-250ms ease-out and honors `prefers-reduced-motion`.

## Motifs

Book spine slats are the signature motif: thin vertical rules and varied-height spine bars inspired by wooden library atrium walls. Use them sparingly for login panels, empty states, and section dividers.

Catalogue cards are the second motif: surfaces with faint ruled headers and monospaced call-number labels.

## Components

Components live in `/web/src/shared` and are shown on `/design`:

Button, TextField, Select, Tabs, SegmentedControl, Card, CatalogCard, StatusBadge, DataTable, StatCard, Toast, Dialog, Drawer, Stepper, EmptyState, Skeleton, LangSwitch, ThemeSwitch, BookSpines, and Logo.

Status indicators must always combine icon plus text label. Color alone is never enough.

## Kiosk Mode

Kiosk mode uses a 20px base font and touch targets of at least 64px. Primary text contrast must be at least 7:1. Do not rely on hover-only interactions.

## Do / Don't

Do use warm tonal surfaces, hairline borders, restrained brass highlights, forest accent, visible focus, bilingual labels, and monospaced IDs.

Do not use glass panels, backdrop blur, large drop shadows, purple-blue gradients, stock hero imagery, emoji icons, default Tailwind blue, or color-only status.
