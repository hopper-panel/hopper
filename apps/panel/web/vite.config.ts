import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Third-party code grouped into chunks that change at different rates.
 *
 * Order matters: the first match wins, so a package that is a prefix of
 * another has to come after it.
 */
const CHUNKS: [string, string[]][] = [
  ['terminal', ['@xterm/xterm', '@xterm/addon-fit']],
  ['data', ['@tanstack/react-query', 'zod']],
  ['react', ['react-router-dom', 'react-dom', 'react']],
];

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
        // Vite 8 dropped the object form and takes a function only. The
        // mapping is spelled out rather than derived from the module id so a
        // dependency landing in the wrong chunk stays a visible mistake in this
        // table, not a regex that silently stopped matching.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) {
            return undefined;
          }

          for (const [chunk, packages] of CHUNKS) {
            // Matched on the path segment, not on a bare substring: `react` as
            // a substring also appears in `react-router-dom` and
            // `@tanstack/react-query`, which belong to other chunks.
            if (packages.some((name) => id.includes(`node_modules/${name}/`))) {
              return chunk;
            }
          }

          return undefined;
        },
      },
    },
  },
});
