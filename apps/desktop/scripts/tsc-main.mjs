#!/usr/bin/env node
import { spawn } from 'node:child_process';

const proc = spawn('tsc', ['--project', 'tsconfig.main.json'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

proc.on('exit', (code) => process.exit(code ?? 1));
