<#
  setup.ps1 — one-shot bootstrap for the MAMATA Survey Android wrapper.

  Run this once after cloning the repo (or pulling for the first time
  after the Android Application/ folder appears). It:

    1. Verifies prerequisites (Node, npm) and warns about Java / Android SDK
       if they look missing (the actual APK build needs them, but install
       can complete without).
    2. Installs Capacitor + plugin dependencies (`npm install`).
    3. Generates the parent web build (`npm run build` in the parent).
    4. Copies dist/ → www/ and adds the Android platform.
    5. Prints next-step guidance (Firebase Auth domain whitelist, keystore
       generation, build commands).

  Usage (from the Android Application folder):
      powershell -ExecutionPolicy Bypass -File .\setup.ps1
#>

$ErrorActionPreference = 'Stop'

function Write-Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Write-Ok($t)      { Write-Host "  [OK] $t"   -ForegroundColor Green }
function Write-Warn($t)    { Write-Host "  [WARN] $t" -ForegroundColor Yellow }
function Write-Err($t)     { Write-Host "  [ERR ] $t" -ForegroundColor Red }

Push-Location $PSScriptRoot
try {
  Write-Section 'Prerequisites'

  # Node — we need 18+ for Vite 6 and Capacitor 6.
  $node = (& node --version) 2>$null
  if (-not $node) { Write-Err 'Node.js is not on PATH. Install Node 18 LTS or newer.'; exit 1 }
  Write-Ok "node $node"

  $npm = (& npm --version) 2>$null
  if (-not $npm) { Write-Err 'npm is not on PATH. Reinstall Node.js.'; exit 1 }
  Write-Ok "npm $npm"

  # Java — actually only needed at gradle build time, but warning up
  # front avoids confusion later.
  $java = (& java -version) 2>&1 | Select-Object -First 1
  if ($java -match 'version') {
    Write-Ok $java
  } else {
    Write-Warn 'Java not found. You will need JDK 17 to build the APK (set JAVA_HOME).'
  }

  # ANDROID_HOME / ANDROID_SDK_ROOT
  $sdk = $env:ANDROID_HOME
  if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
  if ($sdk -and (Test-Path $sdk)) {
    Write-Ok "Android SDK at $sdk"
  } else {
    Write-Warn 'ANDROID_HOME / ANDROID_SDK_ROOT is not set. You will need the Android SDK to build the APK (Android Studio installs it for you).'
  }

  Write-Section 'Install Capacitor + plugins'
  npm install
  Write-Ok 'npm install complete'

  Write-Section 'Build the parent React app'
  Push-Location ..
  try {
    npm install     # in case parent deps are stale
    npm run build
    Write-Ok 'Parent web build complete (../dist/)'
  } finally { Pop-Location }

  Write-Section 'Copy web build into www/'
  npm run copy-web
  Write-Ok 'www/ populated'

  Write-Section 'Add Android platform'
  if (Test-Path 'android') {
    Write-Ok 'android/ already exists — skipping (run `npx cap update android` if you need to refresh native deps).'
  } else {
    npx cap add android
    Write-Ok 'android/ scaffolded'
  }

  Write-Section 'Sync web -> native'
  npx cap sync android
  Write-Ok 'Capacitor sync complete'

  Write-Host ''
  Write-Host '======================================================' -ForegroundColor Green
  Write-Host ' SETUP COMPLETE' -ForegroundColor Green
  Write-Host '======================================================' -ForegroundColor Green
  Write-Host ''
  Write-Host 'Next steps:' -ForegroundColor White
  Write-Host '  1. Whitelist the Capacitor origin in Firebase Auth:' -ForegroundColor White
  Write-Host '     Firebase Console -> Authentication -> Settings ->' -ForegroundColor Gray
  Write-Host '     Authorized domains -> add `localhost` (if not already there).' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  2. Open the Android project to verify everything builds:' -ForegroundColor White
  Write-Host '       npm run open' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  3. Build a debug APK for sideload-testing:' -ForegroundColor White
  Write-Host '       npm run build:debug' -ForegroundColor Yellow
  Write-Host '     Output: android\app\build\outputs\apk\debug\app-debug.apk' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  4. For a signed release APK, see BUILD_INSTRUCTIONS.md.' -ForegroundColor White
  Write-Host ''
}
finally { Pop-Location }
