import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // L'API est appelée en chemin relatif (`/api/...`) : ce proxy fait que le
    // navigateur voit une seule origine en développement, donc les cookies
    // httpOnly d'authentification partent avec chaque requête sans configuration
    // CORS particulière côté client.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    // Le build reste dans le paquet qui le produit. Écrire dans le `dist` du
    // panel exposait à une course : `nest build` efface son répertoire de
    // sortie, et rien n'ordonne les deux constructions — le front se faisait
    // supprimer une fois sur deux. Le panel lit ce dossier au démarrage.
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        /**
         * Le terminal pèse à lui seul près de la moitié du paquet, et n'est
         * utile que sur la console. En un seul fichier, chaque mise à jour du
         * panel — même une correction d'une ligne dans un écran d'admin —
         * invalidait le cache du navigateur pour tout, xterm compris.
         *
         * Les découpes sont faites par dépendance et non par route : le
         * découpage par route imposerait des imports différés partout, pour un
         * gain moindre — c'est le code tiers qui pèse, pas le nôtre.
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
