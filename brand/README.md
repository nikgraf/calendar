# Solunivo brand assets

The selected identity is **A1 soft ivory, with 24 in Inter Bold**: a near-white paper face, mint curl and continuous blush backing. A1 retains the original numeral size and position; the centered studies are not part of the selected identity. The horizontal logo uses **Inter SemiBold**, with the icon at **115% of the lettering’s visible height**. The interface palette and dark icon remain proposed foundations.

## Where files live

| Location                           | Contents                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `icons/`                           | Canonical vector icon variants; `solunivo.svg` is the selected default |
| `logos/`                           | Outlined wordmarks and horizontal/stacked logo SVGs                    |
| `fonts/`                           | Inter 4.1 source fonts, variable webfont and SIL Open Font License     |
| `tokens/tokens.json`               | Authoritative brand and semantic UI tokens                             |
| `tokens/tokens.css`                | Generated CSS for the preview and future UI integration                |
| `preview/`                         | Curated brand preview with a sample calendar and event editor          |
| `../scripts/brand/build.mjs`       | Export, validation and distribution build                              |
| `../apps/desktop/assets/icon.icns` | Generated macOS icon used by Forge                                     |
| `../apps/ios/assets/icon.png`      | Generated opaque 1024 × 1024 icon used by Expo                         |
| `../output/branding/`              | Ignored studies, PNG sets, iconsets and distribution ZIPs              |

The SVGs are editable vector sources with outlined lettering, gradients and filters. They have no linked images or font dependencies. Edit these masters and regenerate their raster exports. Earlier exploration galleries stay outside Git. Proposed artwork is clearly labeled in the preview and is not enabled as a native appearance.

## Build and check

Install repository dependencies with `pnpm install`. Brand generation requires **macOS** for the system `iconutil` command; Sharp and fflate are pinned in the root package. No Python, Swift, global Node packages or Codex runtime is required.

```sh
pnpm brand:build
pnpm brand:check
```

`brand:build` refreshes the two tracked app icons and `tokens/tokens.css`, renders export sizes, checks 50 contrast pairs, and writes the complete distribution to `output/branding/solunivo-brand-kit/` and `output/branding/solunivo-brand-kit.zip`.

`brand:check` regenerates those tracked files in a temporary directory and compares their bytes. It fails on stale assets or insufficient contrast without changing the working tree. When updating a master, include the regenerated app assets and CSS in the same commit.

Ordinary app builds consume the committed ICNS/PNG files and do not run the brand generator. There is no tray feature today, so no unused tray assets are committed; monochrome exports are included in the generated kit for future use.

To view the generated kit locally:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory output/branding
```

Open `http://127.0.0.1:8765/solunivo-brand-kit/preview/`. The preview loads its fonts locally. Its calendar contains sample data; edits last only until reload.

## Logo usage

| Use                               | File                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| Horizontal on light backgrounds   | `logos/lockup-horizontal-light.svg`                               |
| Horizontal on dark backgrounds    | `logos/lockup-horizontal-dark.svg`                                |
| Stacked on light/dark backgrounds | `logos/lockup-stacked-light.svg`, `logos/lockup-stacked-dark.svg` |
| Wordmark alone                    | `logos/wordmark-plum.svg`, `logos/wordmark-ivory.svg`             |
| One-color wordmark                | `logos/wordmark-black.svg`, `logos/wordmark-white.svg`            |
| One-color symbol                  | `icons/solunivo-monochrome.svg`                                   |

Light/dark lockup filenames describe their intended **background**. Both use the selected soft ivory icon. The plum-faced `icons/solunivo-dark.svg` is a separate proposed app appearance, with soft ivory numerals.

- The horizontal icon-to-lettering height ratio is **1.15:1**. Its gap is **0.33×** the visible wordmark height. Alignment uses visible artwork centers, excluding transparent canvas padding and the shadow.
- The wordmark uses Inter SemiBold 600 with −0.013 em tracking. The outlined icon numerals use Inter Bold 700. The static 24 represents a complete day, not today’s date.
- Leave clear space of at least one-quarter of the visible icon height around a lockup. For the wordmark alone, leave half its capital height.
- Starting minimums at 1×: horizontal **200 px wide**, stacked **100 px wide**, wordmark **90 px wide**. Prefer the detailed standalone icon at 32 px or larger. Inspect smaller exports at actual size.
- Scale uniformly and preserve the supplied spacing. Do not add strokes to the wordmark. The stacked logo has its own composition.

## Platform icons

The macOS ICNS retains the selected transparent canvas, dimensional shading and folded silhouette. Forge references the committed file directly.

The iOS export derives from the same master: the outer paper edges extend to fill an opaque square; the numeral and curl paths stay intact. Expo generates the required sizes from the PNG, and iOS applies its corner mask. See the [Expo icon guidance](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/#app-icon) and [Forge icon configuration](https://www.electronforge.io/guides/create-and-add-icons).

The iOS adapter deliberately checks the named SVG shapes and fails if it cannot find them, so future master changes require an explicit review of the platform conversion. Changes to the Expo icon require a native rebuild; an OTA update alone cannot change the installed icon. Native dark/tinted switching and Icon Composer assets remain follow-up work.

## Colors and interface roles

| Brand color | Hex       | Role                                                |
| ----------- | --------- | --------------------------------------------------- |
| Soft ivory  | `#FFFAEC` | Near-white paper with a hint of warmth              |
| Mint        | `#BDD5CE` | Signature fold and supporting accents               |
| Blush       | `#F3D0C5` | Continuous backing and supporting warmth            |
| Plum        | `#6B5473` | Identity, brand text and light-theme primary action |

These are flat identity colors. The existing `ivory` token name is retained for soft ivory; flat icons and reversed wordmarks use `#FFFAEC`. The calendar uses neutral surfaces so event colors remain readable and user-selectable.

The approved A1 paper gradient uses `#FFFDF5` at 0%, `#FFFAEC` at 43%, `#FFF8E6` at 80%, and `#F7EDDA` at 100%. Its edge shade is `#B7B0A3` and the final rim highlight is `#FAF0DE`. These colors lighten the paper toward white while preserving its depth. Keep the mint fold, blush backing, plum numerals and all icon geometry unchanged when applying this treatment.

| UI role                    | Light     | Dark      |
| -------------------------- | --------- | --------- |
| Canvas                     | `#FAF9F6` | `#19171D` |
| Surface                    | `#FFFFFF` | `#242129` |
| Primary text               | `#302A34` | `#F5F0F5` |
| Secondary text             | `#706875` | `#BBB0C1` |
| Primary action             | `#6B5473` | `#CDB8D6` |
| Text on action             | `#FFFFFF` | `#302238` |
| Essential control boundary | `#948899` | `#82718C` |
| Focus ring                 | `#85658E` | `#D6BDE5` |

Use semantic token pairs from `tokens.json` for text and controls. The build requires at least **4.5:1** for the checked normal-text pairs and **3:1** for focus rings and essential control borders on their intended surfaces. Decorative dividers have lower contrast and cannot be the only way to identify an input. Calculated color contrast is not a complete accessibility audit.

Use labels and state indicators alongside color. The sample mint/personal, lilac/work and blush/focus assignments are examples, not permanent product rules.

## Type, spacing and motion

Inter is the shared identity and UI typeface. Font sources come from the [official Inter 4.1 release](https://github.com/rsms/inter/releases/tag/v4.1); retain `fonts/LICENSE.txt` when redistributing them.

| Style   | Size / line height | Weight |
| ------- | ------------------ | ------ |
| Display | 48 px / 1.1        | 600    |
| Title   | 28 px / 1.2        | 600    |
| Heading | 20 px / 1.3        | 600    |
| Body    | 14 px / 1.5        | 400    |
| Label   | 13 px / 1.4        | 500    |
| Caption | 12 px / 1.4        | 400    |

Use tabular numerals for aligned dates and times. Keep body tracking normal. The miniature calendar preview uses reduced type to show the whole layout; the table above is the starting point for product implementation.

Spacing: **4, 8, 12, 16, 24, 32, 48, 64 px**. Starting radii: **6 px** for events, **8 px** for controls and **16 px** for popovers. Keep the fold as an identity feature rather than repeating it in controls.

Use 120 ms press feedback and 180 ms occasional popover transitions where helpful. Repeated calendar operations and keyboard actions should be immediate. Respect reduced motion and provide visible keyboard focus, input labels, errors and save status text.
