import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { productionContentSecurityPolicyMeta } from './src/security/content-security-policy';

export function productionContentSecurityPolicy(): Plugin {
  return {
    apply: 'build',
    name: 'brainstrike-production-csp',
    transformIndexHtml: {
      handler: () => [productionContentSecurityPolicyMeta()],
      order: 'post',
    },
  };
}

export default defineConfig({
  build: {
    assetsDir: 'assets',
    assetsInlineLimit: 0,
    target: 'es2022',
  },
  plugins: [react(), productionContentSecurityPolicy()],
});
