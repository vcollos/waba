import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runtime-safe resolver for the PDF report assets (WABA-25).
 *
 * The paths are resolved from `__dirname`, which points to the directory of
 * THIS compiled module at runtime:
 *   - dev  (tsx watch src/main.ts):  apps/api/src/reports/pdf
 *   - prod (node dist/main.js):      apps/api/dist/reports/pdf
 *
 * In both cases the `assets/` folder sits next to this module:
 *   - dev  -> the vendored source tree (apps/api/src/reports/pdf/assets)
 *   - prod -> copied into dist by the `build` script (see scripts/copy-pdf-assets.mjs),
 *             because `tsc` does NOT emit non-.ts files.
 *
 * Do NOT register these fonts here — that is the report author's job. This
 * module only exposes resolved, existence-checked absolute paths.
 */
const ASSETS_DIR = join(__dirname, 'assets');
const FONTS_DIR = join(ASSETS_DIR, 'fonts');
const LOGO_DIR = join(ASSETS_DIR, 'logo');

export const fonts = {
  /** Manrope — UI / headings font family. Register each weight explicitly. */
  manrope: {
    regular: join(FONTS_DIR, 'manrope-v20-latin-regular.ttf'), // 400
    medium: join(FONTS_DIR, 'manrope-v20-latin-500.ttf'), // 500
    semibold: join(FONTS_DIR, 'manrope-v20-latin-600.ttf'), // 600
    bold: join(FONTS_DIR, 'manrope-v20-latin-700.ttf'), // 700
    extrabold: join(FONTS_DIR, 'manrope-v20-latin-800.ttf'), // 800 (wordmark)
  },
  /** IBM Plex Mono — numeric / tabular values. */
  ibmPlexMono: {
    regular: join(FONTS_DIR, 'IBMPlexMono-Regular.ttf'), // 400
    medium: join(FONTS_DIR, 'IBMPlexMono-Medium.ttf'), // 500
    semibold: join(FONTS_DIR, 'IBMPlexMono-SemiBold.ttf'), // 600
  },
} as const;

/**
 * Logo assets.
 *
 * IMPORTANT: react-pdf's <Image> only renders PNG/JPG, NOT SVG. No SVG
 * rasterizer (rsvg-convert/inkscape/imagemagick/cairosvg) is available on the
 * build host, so only the vendored SVG source ships. Until a PNG is produced,
 * render the brand as a TEXT wordmark: "Collos" in Manrope 800 (fonts.manrope.extrabold).
 *
 * When a PNG becomes available, drop it at assets/logo/logo-collos-positivo.png
 * and set `png` below to `join(LOGO_DIR, 'logo-collos-positivo.png')`.
 */
export const logo = {
  /** Vendored SVG source (reference / future conversion only — NOT usable in <Image>). */
  svgSource: join(LOGO_DIR, 'logo-collos-positivo.svg'),
  symbolSvgSource: join(LOGO_DIR, 'simbolo-comando-positivo.svg'),
  /** Raster logo for <Image>. null today -> use the Manrope 800 wordmark fallback. */
  png: null as string | null,
} as const;

/**
 * Fails fast at boot if any required font is missing from the runtime tree.
 * Call this once (e.g. at PDF module init) to catch a broken build early.
 */
export function assertPdfFontsExist(): void {
  const missing = [
    ...Object.values(fonts.manrope),
    ...Object.values(fonts.ibmPlexMono),
  ].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      `[reports/pdf] Missing font assets at runtime:\n${missing.join('\n')}\n` +
        'Ensure `npm run build --workspace apps/api` ran the copy-pdf-assets step.',
    );
  }
}
