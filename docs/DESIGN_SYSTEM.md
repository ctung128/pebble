# Pebble design system

Pebble's look is defined by **design tokens**: named CSS custom properties in
[`apps/web/src/styles/tokens.css`](../apps/web/src/styles/tokens.css). Components are CSS
Modules that use those names. There's no UI framework or component library.

## Source of truth

- [`docs/design/tokens.json`](design/tokens.json) is the design system's source of truth (v2.1,
  "direction D": white reading page, juniper accent, lichen selection).
- `tokens.css` is generated from it, then hand-checked. **Change the design system first and
  regenerate**; don't tune values in the CSS.
- The JSON defines the light theme, and **the app always renders light**, whatever the
  device's setting. `tokens.css` keeps an interim dark block (the app's earlier dark values
  mapped onto the v2 names) behind `:root[data-theme="dark"]`, which nothing sets yet; it waits
  for a designed v2 dark palette.

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
- **Dark mode (off for now):** every semantic colour still has a dark value. Use semantic names,
  never primitives or hex values, so components follow the theme when it returns.

## GuideTip (the Pebble character beside the transcript)

`components/GuideTip.tsx`: a one-time tip from the Pebble character in the episode view, used
for one tip so far (demo only): the Zhongwen hover tip. It's not a chatbot: no input, no
history, no persistent help button.

- **The exception:** the brand layer stays away from the transcript. The Pebble character may
  appear beside it **only** as this tip: once per session per tip id, dismissible, in the
  margin, never covering transcript text, line actions or the player.
- **Character:** `assets/logo-mark.png` exactly as it is, 44px in the margin (28px inline);
  decorative (`alt=""`, `aria-hidden`). No circle, badge, status dot or floating button.
- **Bubble:** `--bg-subtle`, hairline `--border-subtle`, `--radius-lg`, 234px wide, a hairline
  tail pointing left, no shadow and no juniper fill. Text `--size-body-sm` in
  `--text-primary` ("Tip:" at 500); link in the normal link style; a ghost **Dismiss**
  button (`aria-label` "Dismiss tip", 44px hit area). `role="status"`; it never takes focus,
  adds no key handlers and catches pointer events only on its bubble.
- **Placement:** in the right margin outside `--content-width`, level with the current line
  (inside the 18–66% band `useFollowActive` keeps it in) when the margin has room for it
  (about 340px); otherwise a slim inline row inside the column, directly above the player
  (above "Back to current line" while that shows). Only on devices with a mouse
  (`(hover: hover) and (pointer: fine)`); never on phones or tablets.
- **When:** the current line passes 25% of the lines, or the learner (not Pebble's own
  follow-scroll) scrolls 25% through the transcript. It stays until the learner dismisses it.
  Seen-state lives in `sessionStorage` (in try/catch, with an in-memory fallback).
- **Motion:** the one exception to colour and opacity only, limited to this character: rise
  in (6px, `--duration-base`), the bubble reveals from its tail (scale 0.96 → 1), the text
  fades in (`--duration-fast`), then a 2px, 1.5° idle drift on a 5 s loop. Exit is one fade.
  Under reduced motion there's no movement at all.
- **Hierarchy:** transcript, then player, then episode chrome, then the tip. If it ever
  competes with the first three, make it quieter.

## Adding or changing a token

1. Change it in the design system and regenerate `tokens.json` and `tokens.css`.
2. Give it a dark value (in the interim block, until v2 dark exists).
3. Add any new foreground/background pairing to the contrast test.
4. Run `npm test` and check both themes in the browser.
