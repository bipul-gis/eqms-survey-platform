/**
 * Runs before every `functions` build and on `firebase deploy`.
 * 1) Writes `functions/.env` with WEB_API_KEY (must NOT use prefix FIREBASE_ — reserved by Firebase CLI).
 * 2) Writes `functions/applet-config.runtime.json` — deployed functions always read this file so the
 *    Web API key works even when Cloud Functions Gen2 does not inject `.env` into process.env.
 */
const fs = require('fs');
const path = require('path');

const functionsDir = path.join(__dirname, '..');
const repoRoot = path.join(functionsDir, '..');
const configPath = path.join(repoRoot, 'firebase-applet-config.json');
const envPath = path.join(functionsDir, '.env');
const runtimePath = path.join(functionsDir, 'applet-config.runtime.json');

function main() {
  if (!fs.existsSync(configPath)) {
    console.warn('[inject-functions-env] No firebase-applet-config.json at repo root; skip');
    return;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.warn('[inject-functions-env] Failed to read config:', e.message);
    return;
  }

  if (raw.apiKey) {
    fs.writeFileSync(envPath, `WEB_API_KEY=${raw.apiKey}\n`, 'utf8');
    console.log('[inject-functions-env] wrote', envPath);

    const subset = JSON.stringify({
      apiKey: raw.apiKey,
      projectId: raw.projectId || ''
    });
    fs.writeFileSync(runtimePath, subset + '\n', 'utf8');
    console.log('[inject-functions-env] wrote', runtimePath);
  } else {
    console.warn('[inject-functions-env] firebase-applet-config.json has no apiKey');
  }
}

main();
