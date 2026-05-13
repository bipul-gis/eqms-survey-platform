import type { CapacitorConfig } from '@capacitor/cli';

/**
 * MAMATA Field Survey — Android wrapper config.
 *
 * The Android app is a Capacitor WebView shell around the *exact* same
 * production build of the React web app. No web source is forked — we
 * just point `webDir` at `./www`, which is populated by
 * `scripts/copy-web.js` from the parent project's `dist/`.
 *
 * Why the role-gating works as-is: when an enumerator signs in, the
 * existing role-aware `App.tsx` already renders only the enumerator UI
 * (questionnaires + geospatial-survey-as-enumerator), so we don't need a
 * separate "enumerator-only build" — same Firebase Auth, same Firestore
 * security rules, same routes.
 */
const config: CapacitorConfig = {
  // Reverse-DNS app id. This is permanent for Play Store / sideload —
  // once installed on enumerator phones, changing it makes their existing
  // install effectively a "different app" and they'd have to reinstall.
  // Pick once, keep forever.
  appId: 'bd.gov.eqms.mamata.enumerator',
  appName: 'Geosurvey',

  // `www` is populated by `scripts/copy-web.js` (run as part of
  // `npm run prepare`). We don't symlink to `../dist` directly because
  // Capacitor on Windows occasionally chokes on relative paths during
  // Gradle sync — a local copy sidesteps the issue.
  webDir: 'www',

  // Treat the bundled web app as the canonical app shell — no remote
  // server, no live-reload from production. The WebView still freely
  // makes XHR / WebSocket calls to Firebase / OSM at runtime; we only
  // pin the *static* assets.
  server: {
    androidScheme: 'https',
    // Permit local-network live-reload during development. Has no effect
    // for release builds since `npm run live` is the only thing that
    // injects a remote URL.
    cleartext: true
  },

  android: {
    // Mixed content allows the OSM tile iframes (in the GPS capture
    // widget) to load alongside HTTPS Firebase requests.
    allowMixedContent: true,
    // Keep the WebView's user-agent close to real Chrome so any
    // user-agent sniffing (e.g. by Firebase) doesn't misidentify us.
    captureInput: true,
    webContentsDebuggingEnabled: true
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#0f172a',
      androidScaleType: 'CENTER_CROP',
      showSpinner: true,
      spinnerColor: '#3b82f6'
    },
    StatusBar: {
      // Slate-900 to match the app's header gradient.
      backgroundColor: '#0f172a',
      style: 'DARK'
    },
    Geolocation: {
      // Permission strings — Android surfaces these in the runtime
      // dialog. Keep them honest because the Play Store / Google
      // Play Protect both inspect them.
      permissions: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']
    }
  }
};

export default config;
