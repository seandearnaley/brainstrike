import type { FixtureDefinition } from '../dev-fixture-types';

/**
 * Default inline fixture used by the toolbar dev helper.
 * Provides a small TypeScript project with a few components and utilities.
 */
export const DEV_INLINE_FIXTURE: FixtureDefinition = {
  name: 'mock-project',
  tree: {
    src: {
      'index.ts': `import { Button } from "./components/Button";
import { capitalize } from "./utils/helpers";

export function main(name: string) {
  const safeName = capitalize(name);
  return Button({ label: \`Hello, \${safeName}!\` });
}
`,
      components: {
        'Button.tsx': `import React from "react";

export interface ButtonProps {
  label: string;
}

export function Button({ label }: ButtonProps) {
  return <button className="btn-primary">{label}</button>;
}
`,
        'Input.tsx': `import React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export function Input({ label, ...props }: InputProps) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <input {...props} className="rounded border px-2 py-1" />
    </label>
  );
}
`,
      },
      utils: {
        'helpers.ts': `export function capitalize(value: string): string {
  if (!value) {
    return '';
  }
  return \`\${value[0]?.toUpperCase()}\${value.slice(1)}\`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
`,
      },
    },
    'package.json': `{
  "name": "mock-project",
  "version": "0.1.0",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "19.0.0",
    "react-dom": "19.0.0"
  },
  "devDependencies": {
    "typescript": "5.4.0",
    "vitest": "2.1.0"
  }
}
`,
    'README.md': `# Mock Project

This is a tiny fixture used for Brainstrike development and testing.
It demonstrates a minimal TypeScript + React structure so engineers
can exercise the file explorer without accessing the host file system.
`,
    'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "jsx": "react-jsx",
    "strict": true,
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`,
  },
} satisfies FixtureDefinition;
