import fs from 'fs';

const path = 'packages/file-system/src/adapters/web-adapter.ts';
let content = fs.readFileSync(path, 'utf-8');

// remove the misplaced import
content = content.replace("import { extractPathSegments } from '@brainstrike/utils/path-utils';\n", "");

// put it at the top
content = `import { extractPathSegments } from '@brainstrike/utils/path-utils';\n` + content;
fs.writeFileSync(path, content);
