import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // relative asset paths so the build works from any static host or sub-path
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  // listen on all interfaces so phones on the same network can connect
  server: { host: true, port: 5391 },
  preview: { host: true, port: 4173 },
});
