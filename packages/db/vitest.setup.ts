import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

const memoryDir = resolve(__dirname, ':memory:');

function cleanup() {
  if (existsSync(memoryDir)) {
    rmSync(memoryDir, { recursive: true, force: true });
  }
}

beforeAll(() => {
  // Disable vector extensions in test environment
  process.env.DISABLE_VECTOR_EXTENSION = 'true';
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 1000));
  cleanup();
});
