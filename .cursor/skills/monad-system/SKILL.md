# Monad System — AI Design Skill

## What This Is

The Monad System is a personal design language built on `colors.json`. It is not Carbon. It is not shadcn. It is an **engineered framework** where every visual element earns its place.

> "Form follows Function. If it doesn't facilitate a function, delete it."

## System Tiers

The Monad System has four named tiers. Use these names precisely when describing components or writing code:

| Tier | Role | CSS Scope |
|---|---|---|
| **Strata** | Connective state — CSS tokens, theme, context | `--strata-*` custom properties |
| **Monad** | Structural layout — root containers, shell | `.monad-*` classes |
| **Atomos** | Primitive components — indivisible units | `.atomos-*` classes |
| **Threshold** | Navigation & transitions — state crossings | `.threshold-*` classes |

## Strata — Tokens

All color and state information lives as CSS custom properties. Components NEVER hardcode color.

```css
/* Ground (switches with theme) */
--strata-bg
--strata-layer-01
--strata-layer-02
--strata-layer-03

/* Type */
--strata-text-primary
--strata-text-secondary
--strata-text-disabled

/* Structure */
--strata-border
--strata-border-subtle
--strata-overlay

/* Signal */
--strata-interactive
--strata-interactive-hover
--strata-interactive-active

/* Status */
--strata-info
--strata-success
--strata-warning
--strata-error
--strata-info-bg / --strata-success-bg / --strata-warning-bg / --strata-error-bg

/* Domain (movement — never repurpose for UI status) */
--strata-move-start
--strata-move-hand
--strata-move-foot
--strata-move-finish

/* Misc */
--strata-highlight
--strata-disabled
```

### Theming

Dark theme is `:root` (default). Light theme is `[data-strata="light"]`.

```html
<!-- Toggle theme -->
<button data-mn-theme-toggle>◑</button>
```

`monad.js` reads `localStorage` key `mn-strata` and respects `prefers-color-scheme` as fallback.

## Monad — Structural Layout

```html
<!-- Full shell -->
<header class="monad-header">
  <button class="threshold-toggle" data-mn-rail-toggle>...</button>
  <span class="monad-header__name">AppName</span>
  <nav class="threshold-nav">...</nav>
  <div class="monad-header__actions">
    <button class="strata-toggle" data-mn-theme-toggle>◑</button>
  </div>
</header>

<div class="monad-layout">
  <nav class="monad-rail">
    <div class="monad-rail__section">Main</div>
    <a class="monad-rail__item active" href="#">Overview</a>
    <a class="monad-rail__item" href="#">Analytics</a>
  </nav>
  <main class="monad-content">
    <!-- page content -->
  </main>
</div>
```

### Grid

16-column grid, 8px base unit.

```html
<div class="monad-grid">
  <div class="monad-col-8">Half</div>
  <div class="monad-col-8">Half</div>
</div>
```

Responsive: 16 col → 8 col (≤1056px) → 4 col (≤672px).

## Atomos — Primitive Components

Each Atomos is self-contained. Never add decorative overrides to Atomos; adjust the Strata layer instead.

### Buttons

```html
<button class="atomos-btn atomos-btn--primary">Action</button>
<button class="atomos-btn atomos-btn--secondary">Secondary</button>
<button class="atomos-btn atomos-btn--danger">Destroy</button>
<button class="atomos-btn atomos-btn--ghost">Ghost</button>

<!-- Sizes -->
<button class="atomos-btn atomos-btn--primary atomos-btn--sm">Small</button>
<button class="atomos-btn atomos-btn--primary atomos-btn--lg">Large</button>
```

### Cards

```html
<div class="atomos-card">
  <div class="atomos-card__header">
    <span class="atomos-card__title">Title</span>
  </div>
  <div class="atomos-card__body">Content</div>
</div>

<!-- Variants -->
<div class="atomos-card atomos-card--flat">...</div>
<div class="atomos-card atomos-card--interactive" tabindex="0">...</div>
<div class="atomos-tile">...</div>
```

### Stat (KPI)

```html
<div class="atomos-stat atomos-stat--signal">
  <div class="atomos-stat__eyebrow">Metric</div>
  <div class="atomos-stat__value">2,847</div>
  <div class="atomos-stat__delta atomos-stat__delta--up">↑ 12%</div>
</div>
```

Variants: `--signal`, `--success`, `--warning`, `--error`

### Tags & Badges

```html
<span class="atomos-tag atomos-tag--info">info</span>
<span class="atomos-tag atomos-tag--success">success</span>
<span class="atomos-tag atomos-tag--warning">warning</span>
<span class="atomos-tag atomos-tag--error">error</span>
<span class="atomos-tag atomos-tag--neutral">neutral</span>

<span class="atomos-badge">4</span>
<span class="atomos-badge atomos-badge--error">!</span>
```

### Notices

```html
<div class="atomos-notice atomos-notice--warning">
  <span class="atomos-notice__icon">!</span>
  <div class="atomos-notice__body">
    <div class="atomos-notice__title">Title</div>
    <div class="atomos-notice__msg">Message body here.</div>
  </div>
</div>
```

### Forms

```html
<div class="atomos-field">
  <label class="atomos-label">Field Name</label>
  <input class="atomos-input" type="text" placeholder="...">
  <span class="atomos-helper">Helper text</span>
</div>

<select class="atomos-select">...</select>
<textarea class="atomos-textarea"></textarea>

<!-- Error state -->
<input class="atomos-input atomos-input--error">
<span class="atomos-helper atomos-helper--error">Error message</span>

<!-- Switch -->
<label class="atomos-switch">
  <input type="checkbox">
  <span class="atomos-switch__track"></span>
  <span class="atomos-switch__label">Label</span>
</label>
```

### Table

```html
<div class="atomos-table-wrap">
  <table class="atomos-table atomos-table--zebra">
    <thead><tr><th>Col</th></tr></thead>
    <tbody><tr><td>Row</td></tr></tbody>
  </table>
</div>
```

### Progress

```html
<div class="atomos-progress">
  <div class="atomos-progress__fill" style="--progress: 72%"></div>
</div>
<!-- Variants: --success, --warning, --error on the fill -->
```

### Domain Holds (Movement Only)

```html
<span class="atomos-hold atomos-hold--start">Start</span>
<span class="atomos-hold atomos-hold--hand">Hand</span>
<span class="atomos-hold atomos-hold--foot">Foot</span>
<span class="atomos-hold atomos-hold--finish">Finish</span>
```

**Rule:** These are movement-domain colors. Never repurpose for general UI status.

## Threshold — Navigation

```html
<!-- Header nav (collapses to hamburger ≤1056px) -->
<button class="threshold-toggle" aria-expanded="false">
  <span class="threshold-toggle__bar"></span>
  <span class="threshold-toggle__bar"></span>
  <span class="threshold-toggle__bar"></span>
</button>
<nav class="threshold-nav">
  <a href="#" class="active">Overview</a>
  <a href="#">Analytics</a>
</nav>

<!-- Rail toggle (opens monad-rail off-canvas) -->
<button data-mn-rail-toggle>☰</button>

<!-- Overlay backdrop (auto-injected by monad.js if absent) -->
<div class="threshold-overlay"></div>
```

`monad.js` wires all threshold interactions automatically.

## Strata Toggle

```html
<button class="strata-toggle" data-mn-theme-toggle aria-label="Toggle theme">◑</button>
```

## Typography

```css
--font-sans:   'Inter', 'Helvetica Neue', Arial, sans-serif;
--font-mono:   'JetBrains Mono', 'Menlo', 'Courier New', monospace;
--font-serif:  'Lora', 'Georgia', Times, serif;
```

- Sans: all UI text
- Mono: labels, overlines, code, data, numeric values
- Serif: editorial / longform only

## Visual Principles

1. **No border-radius** — The system is orthogonal. Softness is not structural. If you add `border-radius`, you are adding decoration.
2. **No decorative shadows** — Depth is communicated by 1px borders and layered backgrounds (`strata-layer-01/02/03`). Do not add `box-shadow` for aesthetics.
3. **No gradients** — Flat fills only. Color is information, not texture.
4. **Haptic transitions** — All transitions use `var(--threshold-fast)` (80ms linear) by default. Motion is predictable, not expressive.
5. **High-contrast states** — Hover/active states change color completely, not opacity. Interactive feedback should feel solid.
6. **Mono for data** — Numeric values, IDs, timestamps, overlines, and labels use `var(--font-mono)` for visual precision.

## Integration

```html
<link rel="stylesheet" href="path/to/build/monad.css">
<script src="path/to/build/monad.js"></script>
```

Include `monad.js` before `</body>`. It auto-initializes Strata theme, Threshold nav, and Rail drawer.

## Platform Targets

### HTML / CSS / JS

Use `monad.css` + `monad.js`. Reference only `--strata-*` tokens in custom styles.

### Unity C#

```csharp
// Dark theme
Color bg = ColorPalette.Background;
Color signal = ColorPalette.Information2;

// Light theme
Color bgLight = ColorPaletteLight.Background;
```

### Python / Seaborn / Matplotlib

```python
from build.seaborn_palette import PALETTE_DARK, PALETTE_LIGHT, apply_dark_theme

apply_dark_theme()
# or
apply_light_theme()
```

## Regenerating Artifacts

```bash
cd /path/to/monad-system
python src/compile_color.py --json_path colors.json --output_path build/
```

Output: `build/monad.css`, `build/monad.js`, `build/ColorPalette.cs`, `build/ColorPaletteLight.cs`, `build/seaborn_palette.py`

## What NOT to Do

- Do not use `ds-*` classes — they are retired
- Do not hardcode color hex values in components — use `--strata-*`
- Do not add `border-radius` to Atomos
- Do not use movement hold colors (`atomos-hold--*`) for generic status
- Do not use `box-shadow` for depth — use borders
- Do not add `transition: all` with ease curves — use `var(--threshold-fast)` (linear only)
