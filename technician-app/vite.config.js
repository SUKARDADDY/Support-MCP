import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The screens. Vite builds them into dist/, which Tauri embeds in the exe.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    globals: false,
  },
});
