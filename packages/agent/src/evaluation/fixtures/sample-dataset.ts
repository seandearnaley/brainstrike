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
  name: 'sample-retrieval-dataset',
  version: '1.0.0',
  description: 'Sample golden dataset for demonstrating evaluation harness',
  testCases: [
    {
      id: 'sample-001',
      query: 'How does authentication work?',
      expectedFilePaths: ['**/auth/**/*.ts', '**/authentication/**/*.ts'],
      expectedContentPatterns: ['authenticate', 'login', 'session'],
      tags: ['auth', 'security'],
    },
    {
      id: 'sample-002',
      query: 'Database connection handling',
      expectedFilePaths: ['**/db/**/*.ts', '**/database/**/*.ts'],
      expectedContentPatterns: ['connect', 'pool', 'query'],
      minSimilarity: 0.4,
      tags: ['db', 'infrastructure'],
    },
    {
      id: 'sample-003',
      query: 'Error handling patterns',
      expectedFilePaths: ['**/error*/**/*.ts', '**/utils/**/*.ts'],
      expectedContentPatterns: ['Error', 'throw', 'catch'],
      tags: ['errors', 'patterns'],
    },
    {
      id: 'sample-004',
      query: 'API endpoint definitions',
      expectedFilePaths: ['**/routes/**/*.ts', '**/api/**/*.ts', '**/endpoints/**/*.ts'],
      expectedContentPatterns: ['get', 'post', 'handler', 'route'],
      tags: ['api', 'routes'],
    },
    {
      id: 'sample-005',
      query: 'Component rendering logic',
      expectedFilePaths: ['**/components/**/*.tsx', '**/ui/**/*.tsx'],
      expectedContentPatterns: ['return', 'render', 'jsx', 'tsx'],
      tags: ['ui', 'react'],
    },
  ],
};

/**
 * Creates a deterministic mock dataset for CI testing.
 * Results are predictable for regression testing.
 */
export function createMockDataset(): GoldenDataset {
  return {
    name: 'mock-ci-dataset',
    version: '1.0.0',
    description: 'Deterministic mock dataset for CI testing',
    testCases: [
      {
        id: 'mock-001',
        query: 'test query one',
        expectedFilePaths: ['src/file-a.ts', 'src/file-b.ts'],
      },
      {
        id: 'mock-002',
        query: 'test query two',
        expectedFilePaths: ['src/utils/*.ts'],
        expectedContentPatterns: ['util'],
        minSimilarity: 0.5,
      },
      {
        id: 'mock-003',
        query: 'test query three',
        expectedFilePaths: ['src/components/**/*.tsx'],
      },
    ],
  };
}
