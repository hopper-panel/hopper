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
  },
});
