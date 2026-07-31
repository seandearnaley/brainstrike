import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    assetsDir: 'assets',
    target: 'es2022',
  },
  plugins: [react()],
});
