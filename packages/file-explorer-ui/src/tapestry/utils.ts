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

const INDENT_UNIT = 2;
const MAX_INDENT = 6;
const MIN_WIDTH = 10;

export const buildStructureFromContent = (lines: string[]): LineData[] => {
  const lineLengths = lines.map((line) => line.trimEnd().length);
  const maxLength = Math.max(1, ...lineLengths);

  return lines.map((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      return { indent: 0, width: 0, isEmpty: true };
    }

    const leadingWhitespace = line.match(/^\s*/u)?.[0] ?? '';
    const indent = Math.min(
      MAX_INDENT,
      Math.floor(leadingWhitespace.replaceAll('\t', '  ').length / INDENT_UNIT)
    );
    const widthRatio = Math.min(1, trimmed.length / maxLength);
    const width = Math.max(MIN_WIDTH, Math.round(widthRatio * 100));

    return {
      indent,
      width,
      isEmpty: false,
    };
  });
};

export const splitContentLines = (content: string): string[] => {
  const lines = content.split(/\r?\n/u);
  return lines.length > 0 ? lines : [''];
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
      compositeKey: `mock::${name}-${i}`,
      rootFolderId: 'mock',
      path: name,
      name,
      language: ext,
      type: ext.toUpperCase(),
      totalLines,
      structure,
      content: generateContent(totalLines, structure),
      contentStatus: 'ready',
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

export const getStableColorForKey = (key: string): string => {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return generateColor(hash);
};

export const createRangeId = (): string => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `range-${Math.random().toString(36).slice(2)}`;
};
