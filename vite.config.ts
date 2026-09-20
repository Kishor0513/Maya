import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // Proxy backend API during development so no secrets live in the frontend.
      // Configure VITE_API_URL in .env to point at your gateway.
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
