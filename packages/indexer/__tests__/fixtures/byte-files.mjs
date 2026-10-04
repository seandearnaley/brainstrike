import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (/** @type {string} */ chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    /** @type {unknown} */
    let request;
    try {
      request = JSON.parse(input);
    } catch {
      throw new TypeError('Invalid byte observation request');
    }
    if (
      typeof request !== 'object' ||
      request === null ||
      !('root' in request) ||
      typeof request.root !== 'string' ||
      !path.isAbsolute(request.root) ||
      !('needle' in request) ||
      typeof request.needle !== 'string' ||
      request.needle.length === 0
    ) {
      throw new TypeError('Invalid byte observation request');
    }
    const needle = Buffer.from(request.needle);
    const files = readdirSync(request.root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((file) => readFileSync(file).includes(needle));
    process.stdout.write(JSON.stringify({ files }));
  } catch (error) {
    process.stderr.write(
      error instanceof Error ? error.message : 'Physical byte observation failed'
    );
    process.exitCode = 1;
  }
});
