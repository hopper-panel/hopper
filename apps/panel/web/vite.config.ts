import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The API is called on a relative path (`/api/...`): this proxy makes the
    // browser see a single origin in development, so the httpOnly
    // authentication cookies travel with every request without any particular
    // client-side CORS configuration.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    // The build stays in the package that produces it. Writing into the
    // panel's `dist` invited a race: `nest build` wipes its output directory,
    // and nothing orders the two builds — the front got deleted every other
    // time. The panel reads this folder at startup.
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        /**
         * The terminal alone weighs nearly half the bundle, and is only
         * useful on the console. In a single file, every panel update — even a
         * one-line fix in an admin screen — invalidated the browser cache for
         * everything, xterm included.
         *
         * The splits are made by dependency and not by route: splitting by
         * route would force lazy imports everywhere, for a smaller gain — it is
         * the third-party code that weighs, not ours.
         */
        manualChunks: {
          terminal: ['@xterm/xterm', '@xterm/addon-fit'],
          react: ['react', 'react-dom', 'react-router-dom'],
          data: ['@tanstack/react-query', 'zod'],
        },
      },
    },
  },
});
