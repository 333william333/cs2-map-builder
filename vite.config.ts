import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:5174',
    },
  },
  worker: { format: 'es' },
  // maplibre-gl 6 ships an ESM worker next to the main bundle; pre-bundling breaks its worker URL
  optimizeDeps: { exclude: ['maplibre-gl'] },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
