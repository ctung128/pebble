# Pebble design system

Pebble's look is defined by **design tokens**: named CSS custom properties in
[`apps/web/src/styles/tokens.css`](../apps/web/src/styles/tokens.css). Components are CSS
Modules that use those names. There's no UI framework or component library.

## Source of truth

- [`docs/design/tokens.json`](design/tokens.json) is the design system's source of truth (v2.1,
  "direction D": white reading page, juniper accent, lichen selection).
- `tokens.css` is generated from it, then hand-checked. **Change the design system first and
  regenerate**; don't tune values in the CSS.
- The JSON defines the light theme. The **dark theme in `tokens.css` is interim**: the app's
  earlier dark values mapped onto the v2 names, so dark mode keeps working until a v2 dark
  palette is designed.

## Token tiers

1. **Primitives** (`--white`, `--rice-50`, `--juniper-600`, `--rust-700`, …): the raw palette.
   Components never use these.
2. **Semantic** names: what components use.
   - Backgrounds: `--bg-page`, `--bg-subtle`, `--bg-muted`, `--bg-hover`, `--bg-selected`,
     `--bg-active`, `--bg-inset`
   - Text: `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-accent`,
     `--text-on-accent`
   - Accent: `--accent`, `--accent-hover`, `--accent-pending` (**non-text fills only**)
   - Borders: `--border-subtle` and `--border-default` are **decorative only**;
     `--border-control` (3:1 or better) outlines inputs, checkboxes and other controls;
     `--border-selected`
   - Focus: `--focus-ring`, `--focus-width`
   - Status: `--error`, `--error-bg`, `--error-border`, `--warning`, `--warning-bg`,
     `--warning-border`
   - Brand imagery (`--img-*`, `--seal`): illustrations only, never UI fills.
3. **Sizes**: type (`--size-*`, in `rem` so the browser's font-size setting works), spacing
   (`--space-half` … `--space-10`, 4-based), radii and shapes, border widths
   (`--border-width-hairline`, `--border-width-selected`), control sizes, rings and the one
   popover shadow (built from semantic colours, so they follow the theme), and motion
   (`--duration-fast`, `--duration-base`, `--easing-standard`; zero under reduced motion).

A **temporary alias block** at the end of `tokens.css` maps the v1 names (`--bg`,
`--surface`, `--text-muted`, `--warn-bg`, `--radius-s`, `--text-xl`, …) onto v2 so existing
modules keep working. New code uses the semantic names; delete the block once nothing uses the
v1 names.

`--space-5` and `--space-6` are **not** aliased: v2 reuses those names with new values (20px
and 24px). The v1 uses were migrated when v2 landed (`--space-5` → `--space-6`,
`--space-6` → `--space-10`), so layouts didn't change.

## Typography

- **UI and body:** Work Sans (variable, SIL OFL 1.1), self-hosted from
  `@fontsource-variable/work-sans` and imported in `main.tsx`. No font is fetched from a third
  party at runtime.
- **Display** (page and episode titles, `h1`): `--font-display`, weight 400 only (never bold).
  The face is Huiwen Mincho. `styles/fonts.css` uses it **when it's installed on the
  computer**, via `local("Huiwen-mincho")` and `local("汇文明朝体")`; otherwise titles use the
  rest of the stack (Songti SC, Noto Serif SC, serif). No font file is bundled until its
  redistribution licence is confirmed; then ship only a small subset (Latin, CJK punctuation
  and the fixed UI strings) as a `url()` source after the `local()` ones, with its licence
  next to the file.
- **Chinese transcript text:** `--font-zh` (system Chinese fonts).

## Accessibility rules

- **Contrast:** text pairs at least 4.5:1; control outlines, focus rings and non-text fills at
  least 3:1, in **both themes**. `apps/web/src/styles/tokens.test.ts` checks the documented
  pairs against the real `tokens.css`; add a pair there when you introduce a new combination.
- **Focus:** always visible (`:focus-visible`, `--focus-width` ring in `--focus-ring`, 2px
  offset). Never remove an outline without an equally visible replacement.
- **Reduced motion:** `global.css` turns off animation and smooth scrolling under
  `prefers-reduced-motion`; use the motion tokens rather than fixed durations.
- **Forced colours:** focus falls back to the system `Highlight` colour.
- **Dark mode:** every semantic colour has a dark value. Use semantic names, never primitives
  or hex values, so components follow the theme.

## Adding or changing a token

1. Change it in the design system and regenerate `tokens.json` and `tokens.css`.
2. Give it a dark value (in the interim block, until v2 dark exists).
3. Add any new foreground/background pairing to the contrast test.
4. Run `npm test` and check both themes in the browser.
