import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Адрес сайта не прописан в коде: базовый путь берётся из VITE_BASE_PATH
// (например /glossary/ для ник.github.io/glossary). При переезде меняется только он.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react()],
    build: { chunkSizeWarningLimit: 1500 }
  };
});
