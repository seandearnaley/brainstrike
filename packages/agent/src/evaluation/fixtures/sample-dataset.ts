/**
 * Sample golden dataset for retrieval evaluation (BST-175)
 *
 * This is a template/example dataset. Real datasets should be created
 * based on actual codebase queries and expected results.
 */

import type { GoldenDataset } from '../types';

/**
 * Sample dataset demonstrating the golden dataset format.
 * Use this as a template for creating domain-specific datasets.
 */
export const sampleGoldenDataset: GoldenDataset = {
  description: 'Sample golden dataset for demonstrating evaluation harness',
  name: 'sample-retrieval-dataset',
  testCases: [
    {
      expectedContentPatterns: ['authenticate', 'login', 'session'],
      expectedFilePaths: ['**/auth/**/*.ts', '**/authentication/**/*.ts'],
      id: 'sample-001',
      query: 'How does authentication work?',
      tags: ['auth', 'security'],
    },
    {
      expectedContentPatterns: ['connect', 'pool', 'query'],
      expectedFilePaths: ['**/db/**/*.ts', '**/database/**/*.ts'],
      id: 'sample-002',
      minSimilarity: 0.4,
      query: 'Database connection handling',
      tags: ['db', 'infrastructure'],
    },
    {
      expectedContentPatterns: ['Error', 'throw', 'catch'],
      expectedFilePaths: ['**/error*/**/*.ts', '**/utils/**/*.ts'],
      id: 'sample-003',
      query: 'Error handling patterns',
      tags: ['errors', 'patterns'],
    },
    {
      expectedContentPatterns: ['get', 'post', 'handler', 'route'],
      expectedFilePaths: ['**/routes/**/*.ts', '**/api/**/*.ts', '**/endpoints/**/*.ts'],
      id: 'sample-004',
      query: 'API endpoint definitions',
      tags: ['api', 'routes'],
    },
    {
      expectedContentPatterns: ['return', 'render', 'jsx', 'tsx'],
      expectedFilePaths: ['**/components/**/*.tsx', '**/ui/**/*.tsx'],
      id: 'sample-005',
      query: 'Component rendering logic',
      tags: ['ui', 'react'],
    },
  ],
  version: '1.0.0',
};

/**
 * Creates a deterministic mock dataset for CI testing.
 * Results are predictable for regression testing.
 */
export function createMockDataset(): GoldenDataset {
  return {
    description: 'Deterministic mock dataset for CI testing',
    name: 'mock-ci-dataset',
    testCases: [
      {
        expectedFilePaths: ['src/file-a.ts', 'src/file-b.ts'],
        id: 'mock-001',
        query: 'test query one',
      },
      {
        expectedContentPatterns: ['util'],
        expectedFilePaths: ['src/utils/*.ts'],
        id: 'mock-002',
        minSimilarity: 0.5,
        query: 'test query two',
      },
      {
        expectedFilePaths: ['src/components/**/*.tsx'],
        id: 'mock-003',
        query: 'test query three',
      },
    ],
    version: '1.0.0',
  };
}
