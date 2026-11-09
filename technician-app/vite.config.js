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
    // A promise nobody handled fails the run. Vitest's default is the same; it is written here so
    // nobody turns it off to quiet a test, and the screens' loops catch their own errors.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
