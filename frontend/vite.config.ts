import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies backend paths to a locally running gallery (BACKEND, default https://localhost)
const backend = process.env.BACKEND ?? 'https://localhost';
const proxy = Object.fromEntries(
  ['/api', '/artifacts', '/client'].map((path) => [path, { target: backend, secure: false, changeOrigin: true }]),
);

export default defineConfig({
  plugins: [react()],
  server: { proxy },
});
