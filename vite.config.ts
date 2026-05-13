import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Service worker / PWA support — lets the web app load even when the
      // enumerator is offline (matches the Android app's bundled-assets
      // behaviour). Firestore handles its own offline queue via IndexedDB;
      // the SW only worries about the static shell + same-origin assets.
      VitePWA({
        registerType: 'autoUpdate',
        // Inject the SW registration helper into our index.html — keeps the
        // existing module entrypoint untouched, so AI Studio / strict
        // bundlers don't trip on it.
        injectRegister: 'auto',
        // Generate `manifest.webmanifest` ourselves rather than letting the
        // plugin discover it from /public, so future icon swaps stay in one
        // place. `display: standalone` is what makes Android "Add to home
        // screen" launch the app full-screen.
        manifest: {
          name: 'EQMS Geosurvey',
          short_name: 'EQMS Survey',
          description:
            'EQMS Geosurvey — offline-capable enumerator app for household questionnaire and geospatial feature collection.',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          icons: [
            {src: 'pwa-192.png', sizes: '192x192', type: 'image/png'},
            {src: 'pwa-512.png', sizes: '512x512', type: 'image/png'},
            {src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable'}
          ]
        },
        workbox: {
          // Heavy chunks (Firebase, Leaflet vendor) push us past Workbox's
          // 2 MiB default precache limit. Lift to 6 MiB so the whole shell is
          // available offline on first reconnect.
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          // Skip waiting + clients claim → newly built SW takes over on next
          // visit without forcing the user through a manual refresh.
          clientsClaim: true,
          skipWaiting: true,
          // Static landmark geojson is bundled into /assets but is huge
          // (~1.4 MB). Pre-cache it so the map's landmark layer survives
          // offline use.
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2,geojson}'],
          // Runtime caching for *third-party* GETs: OSM tiles & similar
          // basemap requests. Firebase / Firestore traffic deliberately
          // bypasses the SW so its own offline cache keeps authority.
          runtimeCaching: [
            {
              urlPattern:
                /^https:\/\/[a-c]\.tile\.openstreetmap\.org\/.*\.png$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'osm-tiles',
                expiration: {maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30}
              }
            },
            {
              urlPattern: /^https:\/\/fonts\.(gstatic|googleapis)\.com\/.*/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts',
                expiration: {maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365}
              }
            }
          ],
          // Don't try to handle the Capacitor APK's `capacitor://` scheme.
          navigateFallbackDenylist: [/^\/_/, /\/[^/?]+\.[^/]+$/]
        },
        // Disable the SW in development so HMR / live-reload aren't fighting
        // a cache layer; the plugin still exposes itself for testing if you
        // pass `?pwa=true` to the dev server.
        devOptions: {enabled: false}
      })
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          // Manual vendor chunking so a single ~2 MB index.js does not block
          // LCP on first load. Splits by domain so the browser can fetch in
          // parallel and admins/enumerators only download what their screens
          // actually need (heavy libs are also dynamically imported below).
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('firebase')) return 'vendor-firebase';
            if (id.includes('leaflet')) return 'vendor-leaflet';
            if (id.includes('lucide-react')) return 'vendor-icons';
            if (id.includes('motion') || id.includes('framer-motion')) return 'vendor-motion';
            if (id.includes('shp-write') || id.includes('@mapbox') || id.includes('jszip'))
              return 'vendor-shp';
            if (id.includes('@google/genai')) return 'vendor-genai';
            if (
              id.includes('react-dom') ||
              id.includes('scheduler') ||
              id.includes('/react/')
            )
              return 'vendor-react';
            return 'vendor';
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      port: 3000,
      strictPort: true,
      host: '0.0.0.0',
    },
  };
});
