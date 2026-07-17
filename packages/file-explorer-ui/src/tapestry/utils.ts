import { TAPESTRY_COLOR_HEX, TAPESTRY_COLOR_NAMES } from '@brainstrike/types';
import { generateUUID } from '@brainstrike/utils/crypto';
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
] as const;

const CODE_FRAGMENTS = [
  "import React, { useState, useEffect } from 'react';",
  'export const Component = ({ props }) => {',
  '  const [state, setState] = useState(null);',
  '  // Note: Refactor this branch when requirements change',
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
] as const;

const COMMENTS = [
  '// This function handles the user authentication flow',
  '// Optimize this loop for large datasets',
  '/**\n * Helper utility for formatting dates\n * @param date Date object\n */',
  '// Review: Subscription cleanup is handled by the caller',
] as const;

// Auto-assign palette derived from the single source of truth in
// @brainstrike/types so it can't drift from the agent-set tapestry colors. The
// first 8 names are the auto-assign palette; `gray` (the de-emphasis color) is
// intentionally excluded from automatic assignment.
const COLORS = TAPESTRY_COLOR_NAMES.slice(0, 8).map((name) => TAPESTRY_COLOR_HEX[name]);
const MAX_ACCESSIBLE_LINE_EXCERPT = 80;

export const getTapestryLensLineExcerpt = (line: string): string => {
  const normalized = line.trim().replace(/\s+/g, ' ');
  return (normalized || 'Empty line').slice(0, MAX_ACCESSIBLE_LINE_EXCERPT);
};

const getRandomItem = <T>(items: readonly T[]): T => {
  if (items.length === 0) {
    throw new Error('Cannot select a random item from an empty array');
  }
  const index = Math.floor(Math.random() * items.length);
  const item = items[index];
  if (item === undefined) {
    throw new Error('Random item lookup returned undefined');
  }
  return item;
};

const getCycledItem = <T>(items: readonly T[], index: number): T => {
  if (items.length === 0) {
    throw new Error('Cannot select a cycled item from an empty array');
  }
  const normalizedIndex = ((index % items.length) + items.length) % items.length;
  const item = items[normalizedIndex];
  if (item === undefined) {
    throw new Error('Cycled item lookup returned undefined');
  }
  return item;
};

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
      isEmpty,
      width: isEmpty ? 0 : width,
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
    if (Math.random() < 0.1) {
      return indentStr + getRandomItem(COMMENTS);
    }

    // Trim fragment and apply current indent
    return indentStr + getRandomItem(CODE_FRAGMENTS).trim();
  });
};

const INDENT_UNIT = 2;
const MAX_INDENT = 6;
const MIN_WIDTH = 10;
const MINIMAP_MIN_HEIGHT = 120;
const MINIMAP_LINE_PADDING = 16;
const MINIMAP_MAX_BASE_HEIGHT = 320;
const MINIMAP_MAX_HEIGHT_PER_DENSITY_STEP = 80;
const MAX_TAPESTRY_STRUCTURE_SEGMENTS = 320;

export const DEFAULT_TAPESTRY_SCALE = 4;
export const MIN_TAPESTRY_SCALE = 0;
export const MAX_TAPESTRY_SCALE = 8;

export interface TapestryGalleryMetrics {
  cardMinWidth: number;
  gap: number;
  lineDensity: number;
  zoomPercent: number;
}

export interface TapestryStructureSegment extends LineData {
  endLine: number;
  startLine: number;
}

export const buildStructureFromContent = (lines: string[]): LineData[] => {
  const lineLengths = lines.map((line) => line.trimEnd().length);
  const maxLength = Math.max(1, ...lineLengths);

  return lines.map((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      return { indent: 0, isEmpty: true, width: 0 };
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
      isEmpty: false,
      width,
    };
  });
};

export const buildTapestryStructureSegments = (
  structure: readonly LineData[],
  maxSegments = MAX_TAPESTRY_STRUCTURE_SEGMENTS
): TapestryStructureSegment[] => {
  if (structure.length === 0 || maxSegments <= 0) {
    return [];
  }

  const bucketSize = Math.max(1, Math.ceil(structure.length / maxSegments));
  const segments: TapestryStructureSegment[] = [];

  for (let startLine = 0; startLine < structure.length; startLine += bucketSize) {
    const endLine = Math.min(startLine + bucketSize, structure.length);
    let indent = 0;
    let width = 0;
    let hasContent = false;

    for (let lineIndex = startLine; lineIndex < endLine; lineIndex += 1) {
      const line = structure[lineIndex];
      if (!line || line.isEmpty) {
        continue;
      }
      if (!hasContent || line.width > width) {
        indent = line.indent;
        width = line.width;
      }
      hasContent = true;
    }

    segments.push({
      endLine,
      indent: hasContent ? indent : 0,
      isEmpty: !hasContent,
      startLine,
      width: hasContent ? width : 0,
    });
  }

  return segments;
};

export const getTapestryGalleryMetrics = (scale: number): TapestryGalleryMetrics => {
  const safeScale = Math.min(MAX_TAPESTRY_SCALE, Math.max(MIN_TAPESTRY_SCALE, scale));
  return {
    cardMinWidth: 112 + safeScale * 18,
    gap: 8 + safeScale,
    lineDensity: 1 + safeScale * 0.75,
    zoomPercent: 50 + safeScale * 12.5,
  };
};

export const getTapestryRenderMetrics = (
  totalLines: number,
  density: number
): { totalHeight: number; lineScale: number; lineThickness: number } => {
  const safeLines = Math.max(totalLines, 1);
  const minHeight = Math.max(MINIMAP_MIN_HEIGHT, density * MINIMAP_LINE_PADDING);
  const baseHeight = safeLines * density;
  const maxHeight = Math.max(
    minHeight,
    MINIMAP_MAX_BASE_HEIGHT + density * MINIMAP_MAX_HEIGHT_PER_DENSITY_STEP
  );
  const totalHeight = Math.min(Math.max(baseHeight, minHeight), maxHeight);
  const lineScale = totalHeight / safeLines;
  const lineThickness = Math.max(1, lineScale * 0.6);

  return { lineScale, lineThickness, totalHeight };
};

export const generateMockFiles = (count: number): FileTapestry[] => {
  return Array.from({ length: count }).map((_, i) => {
    const name =
      FILE_NAMES[i % FILE_NAMES.length] + (Math.floor(i / FILE_NAMES.length) > 0 ? `_${i}` : '');
    const ext = name.split('.').pop() || 'txt';
    const totalLines = Math.floor(Math.random() * 200) + 50; // 50 to 250 lines

    const initialSelection: TapestryRange = {
      color: generateColor(i),
      endLine: totalLines,
      id: crypto.randomUUID(),
      isActive: true,
      startLine: 0,
    };

    const structure = generateStructure(totalLines);

    return {
      compositeKey: `mock::${name}-${i}`,
      content: generateContent(totalLines, structure),
      contentStatus: 'ready',
      id: crypto.randomUUID(),
      language: ext,
      name,
      path: name,
      rootFolderId: 'mock',
      selections: [initialSelection],
      structure,
      totalLines,
      type: ext.toUpperCase(),
    };
  });
};

// Note: COLORS is a non-empty constant array
export const generateColor = (index: number): string => getCycledItem(COLORS, index);

export const getStableColorForKey = (key: string): string => {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return generateColor(hash);
};

export const createRangeId = (): string => `range-${generateUUID()}`;
