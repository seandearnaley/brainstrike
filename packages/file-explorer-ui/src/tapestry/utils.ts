import type { FileTapestry, LineData, TapestryRange } from './types';

const FILE_NAMES = [
  'App.tsx',
  'index.tsx',
  'utils.ts',
  'server.js',
  'auth.middleware.ts',
  'User.schema.ts',
  'styles.css',
  'Dockerfile',
  'README.md',
  'package.json',
  'api_routes.go',
  'database_config.yaml',
  'transform_data.py',
  'GraphView.tsx',
  'NotificationService.ts',
  'Logger.ts',
  'constants.ts',
  'types.d.ts',
];

const CODE_FRAGMENTS = [
  "import React, { useState, useEffect } from 'react';",
  'export const Component = ({ props }) => {',
  '  const [state, setState] = useState(null);',
  '  // TODO: Refactor this logic',
  '  if (!data) return <Loading />;',
  '  return (',
  "    <div className='container'>",
  '      <h1>Title</h1>',
  '      {items.map(i => <Item key={i.id} {...i} />)}',
  '    </div>',
  '  );',
  '};',
  'function calculateMetric(a, b) {',
  '  return Math.sqrt(a * a + b * b);',
  '}',
  'class Service extends BaseService {',
  '  constructor(config) {',
  '    super(config);',
  '    this.initialized = false;',
  '  }',
  '  async init() {',
  '    await this.db.connect();',
  '    this.initialized = true;',
  '  }',
  '}',
  'const STYLES = {',
  "  primary: '#3b82f6',",
  "  secondary: '#64748b',",
  '};',
];

const COMMENTS = [
  '// This function handles the user authentication flow',
  '// Optimize this loop for large datasets',
  '/**\n * Helper utility for formatting dates\n * @param date Date object\n */',
  '// FIXME: Potential memory leak here',
];

export const generateStructure = (lines: number): LineData[] => {
  const structure: LineData[] = [];
  let indent = 0;

  for (let i = 0; i < lines; i++) {
    // Randomly change indent
    if (Math.random() > 0.8) {
      if (Math.random() > 0.5) {
        indent = Math.min(indent + 1, 4);
      } else {
        indent = Math.max(indent - 1, 0);
      }
    }

    const isEmpty = Math.random() > 0.9;
    const width = Math.random() * 60 + 10; // 10% to 70% width

    structure.push({
      indent: isEmpty ? 0 : indent,
      width: isEmpty ? 0 : width,
      isEmpty,
    });
  }
  return structure;
};

const generateContent = (_lines: number, structure: LineData[]): string[] => {
  return structure.map((line) => {
    if (line.isEmpty) {
      return '';
    }
    const indentStr = '  '.repeat(line.indent);

    // Pick a random fragment or make generic code
    // Note: COMMENTS and CODE_FRAGMENTS are non-empty constant arrays
    if (Math.random() < 0.1) {
      const comment = COMMENTS[Math.floor(Math.random() * COMMENTS.length)] as string;
      return indentStr + comment;
    }

    const fragment = CODE_FRAGMENTS[Math.floor(Math.random() * CODE_FRAGMENTS.length)] as string;
    // Trim fragment and apply current indent
    return indentStr + fragment.trim();
  });
};

export const generateMockFiles = (count: number): FileTapestry[] => {
  return Array.from({ length: count }).map((_, i) => {
    const name =
      FILE_NAMES[i % FILE_NAMES.length] + (Math.floor(i / FILE_NAMES.length) > 0 ? `_${i}` : '');
    const ext = name.split('.').pop() || 'txt';
    const totalLines = Math.floor(Math.random() * 200) + 50; // 50 to 250 lines

    const initialSelection: TapestryRange = {
      id: crypto.randomUUID(),
      startLine: 0,
      endLine: totalLines,
      isActive: true,
      color: generateColor(i),
    };

    const structure = generateStructure(totalLines);

    return {
      id: crypto.randomUUID(),
      name,
      language: ext,
      totalLines,
      structure,
      content: generateContent(totalLines, structure),
      selections: [initialSelection],
    };
  });
};

const COLORS = [
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#22c55e', // green-500
  '#06b6d4', // cyan-500
  '#3b82f6', // blue-500
  '#a855f7', // purple-500
  '#ec4899', // pink-500
];

// Note: COLORS is a non-empty constant array
export const generateColor = (index: number) => COLORS[index % COLORS.length] as string;
