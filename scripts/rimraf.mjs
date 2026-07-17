#!/usr/bin/env node
import { rmSync } from 'node:fs';

for (const target of process.argv.slice(2)) {
  rmSync(target, { force: true, recursive: true });
}
