import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
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
