// WABA-25: copy non-.ts PDF report assets (fonts + logo) into dist/.
// `tsc` only emits .js/.d.ts, so TTF/SVG/PNG assets would be missing at
// runtime (the prod Dockerfile ships only apps/api/dist). This mirrors the
// vendored assets from src into dist after the TypeScript build.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../src/reports/pdf/assets');
const dest = resolve(here, '../dist/reports/pdf/assets');

if (!existsSync(src)) {
  console.error(`[copy-pdf-assets] source not found: ${src}`);
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-pdf-assets] copied ${src} -> ${dest}`);
