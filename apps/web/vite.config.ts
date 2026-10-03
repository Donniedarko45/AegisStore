import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev the SPA runs on :8080 and proxies the API (same origin => cookies + no CORS).
// In production nginx does the same job (deploy/nginx.conf).
const target = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:3000';
// keep the browser's Host (changeOrigin: false) and add X-Forwarded-*; the API's CSRF check compares
// the request Origin with the host the user actually visited
const api = { target, changeOrigin: false, xfwd: true };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 8080, host: '0.0.0.0', proxy: { '/api': api, '/healthz': api } },
  preview: { port: 8080, host: '0.0.0.0', proxy: { '/api': api, '/healthz': api } },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
});
