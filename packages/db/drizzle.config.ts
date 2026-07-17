import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dbCredentials: {
    url: './data/postgres',
  },
  dialect: 'postgresql',
  driver: 'pglite',
  migrations: {
    schema: 'public',
    table: '__drizzle_migrations',
  },
  out: './drizzle',
  schema: './src/schema/index.ts',
  strict: true,
  verbose: true,
});
