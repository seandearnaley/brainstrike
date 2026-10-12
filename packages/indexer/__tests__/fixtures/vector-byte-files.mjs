import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const needle = Buffer.from(request.needle, 'base64');
  const files = readdirSync(request.root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('index.sqlite'))
    .map((entry) => path.join(request.root, entry.name))
    .filter((filename) => readFileSync(filename).includes(needle));
  process.stdout.write(JSON.stringify(files));
});
