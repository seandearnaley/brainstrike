import { afterAll } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const memoryDir = resolve(__dirname, ':memory:');

function cleanup() {
  if (existsSync(memoryDir)) {
    rmSync(memoryDir, { recursive: true, force: true });
  }
}

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 1000));
  cleanup();
});
