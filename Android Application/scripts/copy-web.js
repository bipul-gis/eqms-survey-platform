/**
 * copy-web.js — copies the parent project's `dist/` build output into
 * this Capacitor project's `www/` folder, which Capacitor then bundles
 * into the Android APK's assets.
 *
 * Why a copy instead of a symlink:
 *   - Capacitor's `cap sync android` uses the `webDir` path verbatim and
 *     occasionally trips over symlinks / `..` paths on Windows during
 *     Gradle's asset packaging step.
 *   - A clean physical copy keeps debug + release builds reproducible
 *     and makes the bundled web layer auditable from inside this folder.
 *
 * Usage (called from npm scripts, not directly):
 *   node scripts/copy-web.js
 */

import { cp, rm, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIST = path.resolve(__dirname, '..', '..', 'dist');
const DEST_WWW = path.resolve(__dirname, '..', 'www');

async function main() {
  // Sanity-check that the parent build actually exists. Most-common
  // failure mode here is the user forgot `npm run build:web` in the
  // parent — we want a clear message, not a cryptic "ENOENT".
  try {
    await stat(SRC_DIST);
  } catch {
    console.error(
      '\n[copy-web] ✖ Parent build not found at', SRC_DIST,
      '\n            Run `npm run build:web` first (it builds the React app into ../dist).'
    );
    process.exit(1);
  }

  // Wipe the previous www/ so stale asset hashes don't linger and end
  // up sideloaded as dead weight inside the APK.
  await rm(DEST_WWW, { recursive: true, force: true });
  await mkdir(DEST_WWW, { recursive: true });

  // Node 16.7+ provides `fs.cp` with recursive copy; no dep on `fs-extra`.
  await cp(SRC_DIST, DEST_WWW, { recursive: true });

  console.log('[copy-web] ✓ Copied parent dist/ → www/');
}

main().catch((err) => {
  console.error('[copy-web] ✖', err);
  process.exit(1);
});
