# MAMATA Survey — Android Wrapper

Native Android app for the MAMATA Field Survey Platform. Built with **Capacitor**, which wraps the existing React/Vite web build into a real APK without forking any web code.

- **Same code as the web app.** This folder contains zero copies of the React UI — it points Capacitor at the parent project's `dist/` build output.
- **Enumerator workflow naturally.** The existing role-aware `App.tsx` shows only the enumerator UI when an enumerator signs in, so we don't need a separate enumerator-only build. Admins logging into the APK technically work too, but it's not designed for them.
- **Distribute as APK.** No Play Store required — the APK can be sideloaded via WhatsApp / QR code / USB / Firebase Hosting.

## What you get

| Feature | Status |
|---|---|
| Full enumerator UI (questionnaires, drafts, "My Responses", form filling, GPS capture, geospatial survey) | Works as-is via WebView |
| Firebase Auth (email + password) | Works — add `localhost` to authorized domains |
| Firestore reads/writes (online) | Works |
| Firestore offline persistence (drafts saved offline, sync on reconnect) | Works (Firebase Web SDK uses IndexedDB) |
| GPS capture | Works via Capacitor Geolocation plugin (native permission dialog) |
| OSM map tiles | Works (requires internet) |
| Background GPS | Not configured in this MVP — add `@capacitor/background-mode` later if surveyors need to keep GPS running with the screen off |
| CSV export | Admin-only feature, not relevant for enumerator app |

## Folder structure

```
Android Application/
├── README.md                  ← you are here
├── BUILD_INSTRUCTIONS.md      ← step-by-step debug + release builds
├── package.json               ← Capacitor + plugin deps
├── capacitor.config.ts        ← app id, splash, plugin permissions
├── setup.ps1                  ← Windows one-shot bootstrap
├── scripts/
│   └── copy-web.js            ← copies ../dist → ./www before each sync
├── www/                       ← (generated) web build that ships in the APK
└── android/                   ← (generated) native Android Studio project
```

## Quick start

From this folder:

```powershell
# One-time setup (Windows): installs deps, builds web, scaffolds android/
powershell -ExecutionPolicy Bypass -File .\setup.ps1

# Build a debug APK any time after that:
npm run build:debug
```

Debug APK lands at:
```
android\app\build\outputs\apk\debug\app-debug.apk
```

Copy that APK to a phone (WhatsApp / USB / Drive), open it on the device, allow "Install from unknown sources", and you're done.

## Prerequisites

The setup script will warn if any of these are missing:

1. **Node.js 18+** — already required by the parent web project.
2. **JDK 17** — needed by Gradle to compile the native Android shell. [Adoptium JDK 17](https://adoptium.net/) is a no-fuss installer.
3. **Android SDK** — easiest path: install [Android Studio](https://developer.android.com/studio), open it once, accept the SDK license. That gives you `ANDROID_HOME` and the build-tools automatically. If you don't want the full IDE, the [command-line tools](https://developer.android.com/studio#command-line-tools-only) also work.

## Configuring Firebase

The Capacitor WebView serves your app at `https://localhost/`, so you need that origin allow-listed for Firebase Auth:

1. Firebase Console → **Authentication** → **Settings** → **Authorized domains**
2. Confirm `localhost` is present (it is by default for new projects)
3. No changes needed for Firestore — the app uses the same project & rules as the web build

## Signed release builds

See **BUILD_INSTRUCTIONS.md** for:
- Generating a signing keystore (you only do this once, ever)
- Building a signed release APK
- Hosting the APK on Firebase Hosting + QR-code distribution
- Implementing in-app update prompts so sideloaded users still get auto-update UX

## What this folder does NOT do

- ❌ Modify any code in the parent web project
- ❌ Ship admin-only screens — wait, actually it does (the WebView contains the whole bundle). The role gating in `App.tsx` hides admin UI when an enumerator logs in. If you want a smaller APK that physically excludes admin code, that's a future enhancement (separate Vite entry that imports only enumerator components).
- ❌ Auto-update — sideloaded APKs need a manual reinstall. See BUILD_INSTRUCTIONS.md for an in-app "update available" pattern.
