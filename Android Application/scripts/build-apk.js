#!/usr/bin/env node
/**
 * build-apk.js — single-command "give me an installable APK" pipeline.
 *
 * Why this exists: `npm run build:debug` plus its prerequisites all work, but
 * on a stock Windows machine `gradlew` aborts unless `JAVA_HOME` points at a
 * JDK 17+. Setting that permanently doesn't help current terminals (Cursor /
 * VS Code inherit env from the IDE process they were launched from). So this
 * script:
 *
 *   1. Auto-detects Android Studio's bundled JBR (which always ships with a
 *      compatible JDK) and injects it into `process.env` for the children.
 *   2. Runs the web build → copies dist → syncs into Android → invokes
 *      Gradle's `assembleDebug` — all in a single Node process.
 *   3. Prints the final APK path and size so the user knows exactly what to
 *      send to their phone.
 *
 * Net effect: `npm run apk` always works, even in a fresh terminal, on any
 * Windows / macOS / Linux dev box that has Android Studio installed.
 */

import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// `new URL(import.meta.url).pathname` returns `/F:/...` on Windows, which is
// not a valid OS path. `fileURLToPath` is the correct cross-platform helper.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_APP_DIR = path.resolve(HERE, '..');
const APK_RELATIVE = path.join(
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk'
);

/* ------------------------------------------------------------------ */
/* Step 1: find a JDK. Prefer Android Studio's JBR; fall back to anything   */
/* the user already configured.                                              */
/* ------------------------------------------------------------------ */
function detectJavaHome() {
  if (process.env.JAVA_HOME && existsSync(path.join(process.env.JAVA_HOME, 'bin'))) {
    return process.env.JAVA_HOME;
  }

  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env['ProgramFiles'] || '', 'Android', 'Android Studio', 'jbr'),
          path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'Android Studio', 'jbr'),
          path.join(
            process.env['ProgramFiles(x86)'] || '',
            'Android',
            'Android Studio',
            'jbr'
          ),
          path.join(process.env['ProgramFiles'] || '', 'Android', 'Android Studio', 'jre')
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
            path.join(os.homedir(), 'Library/Application Support/JetBrains/Toolbox/apps/AndroidStudio')
          ]
        : ['/opt/android-studio/jbr', '/usr/lib/jvm/java-17-openjdk'];

  for (const c of candidates) {
    if (c && existsSync(path.join(c, 'bin'))) return c;
  }
  return null;
}

const javaHome = detectJavaHome();
if (!javaHome) {
  console.error(
    '\nERROR: Could not find a JDK. Install Android Studio (recommended) or set\n' +
      'JAVA_HOME to a JDK 17+ installation, then re-run `npm run apk`.\n'
  );
  process.exit(1);
}

process.env.JAVA_HOME = javaHome;
process.env.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH}`;
console.log(`\n[1/4] JDK detected: ${javaHome}`);

/* ------------------------------------------------------------------ */
/* Step 2: build the web app (in the parent React project).                  */
/* ------------------------------------------------------------------ */
console.log('\n[2/4] Building web app (parent project)…');
// Point the Capacitor WebView at the live GeoSurvey API (no Vite proxy on device).
const webBuildEnv = {
  ...process.env,
  VITE_API_BASE_URL: process.env.VITE_API_BASE_URL || 'https://geosurvey.eqmscl.com'
};
execSync('npm run build', {
  cwd: path.resolve(ANDROID_APP_DIR, '..'),
  stdio: 'inherit',
  env: webBuildEnv
});

/* ------------------------------------------------------------------ */
/* Step 3: copy dist → www and sync into the Android project.                */
/* ------------------------------------------------------------------ */
console.log('\n[3/4] Copying web → www and syncing Android plugins…');
execSync('node scripts/copy-web.js', { cwd: ANDROID_APP_DIR, stdio: 'inherit' });
execSync('npx cap sync android', { cwd: ANDROID_APP_DIR, stdio: 'inherit' });

/* ------------------------------------------------------------------ */
/* Step 4: Gradle assembleDebug → produces the signed-with-debug-key APK.    */
/* ------------------------------------------------------------------ */
console.log('\n[4/4] Running Gradle assembleDebug…');
const gradleCmd =
  process.platform === 'win32' ? 'gradlew.bat assembleDebug' : './gradlew assembleDebug';
execSync(gradleCmd, {
  cwd: path.join(ANDROID_APP_DIR, 'android'),
  stdio: 'inherit'
});

/* ------------------------------------------------------------------ */
/* Done. Report where the APK landed.                                        */
/* ------------------------------------------------------------------ */
const apkPath = path.join(ANDROID_APP_DIR, APK_RELATIVE);
if (!existsSync(apkPath)) {
  console.error('\nERROR: Build reported success but APK is missing at:\n  ' + apkPath);
  process.exit(1);
}
const sizeMb = (statSync(apkPath).size / 1024 / 1024).toFixed(2);
console.log('\n' + '='.repeat(60));
console.log('  APK READY');
console.log('='.repeat(60));
console.log(`  Path:  ${apkPath}`);
console.log(`  Size:  ${sizeMb} MB`);
console.log('='.repeat(60));
console.log('\nInstall on a USB-connected phone with developer options on:');
console.log(`  adb install -r "${apkPath}"`);
console.log('\nOr copy the .apk to your phone and tap it to sideload.\n');
