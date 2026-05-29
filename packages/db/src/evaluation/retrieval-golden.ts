export interface RetrievalGoldenChunk {
  content: string;
  embedding: number[];
  id: string;
}

export interface RetrievalGoldenFile {
  chunks: RetrievalGoldenChunk[];
  id: string;
  name: string;
  path: string;
}

export interface RetrievalGoldenQuery {
  embedding: number[];
  expectedFilePaths: string[];
  id: string;
  text: string;
}

export interface RetrievalGoldenDataset {
  embeddingSet: {
    dimensions: number;
    distance: 'cosine' | 'ip' | 'l2';
    modelId: string;
    modelKey: string;
  };
  files: RetrievalGoldenFile[];
  name: string;
  queries: RetrievalGoldenQuery[];
  version: string;
}

export const retrievalGoldenDataset = {
  name: 'retrieval-golden',
  version: '1',
  embeddingSet: {
    modelKey: 'test::retrieval',
    modelId: 'retrieval-test',
    dimensions: 3,
    distance: 'cosine',
  },
  files: [
    {
      id: 'file-auth',
      name: 'auth.ts',
      path: '/src/auth.ts',
      chunks: [
        {
          id: 'chunk-auth-1',
          content: 'Handle login flow and session creation.',
          embedding: [1, 0, 0],
        },
        {
          id: 'chunk-auth-2',
          content: 'Validate refresh tokens for authenticated users.',
          embedding: [0.9, 0.1, 0],
        },
      ],
    },
    {
      id: 'file-db',
      name: 'db.ts',
      path: '/src/db.ts',
      chunks: [
        {
          id: 'chunk-db-1',
          content: 'Open a database connection pool for queries.',
          embedding: [0, 1, 0],
        },
        {
          id: 'chunk-db-2',
          content: 'Execute SQL queries and map results to models.',
          embedding: [0.1, 0.9, 0],
        },
      ],
    },
    {
      id: 'file-ui',
      name: 'button.tsx',
      path: '/src/button.tsx',
      chunks: [
        {
          id: 'chunk-ui-1',
          content: 'Render a primary button component with label.',
          embedding: [0, 0, 1],
        },
        {
          id: 'chunk-ui-2',
          content: 'Apply button hover styles and focus ring.',
          embedding: [0, 0.2, 0.8],
        },
      ],
    },
  ],
  queries: [
    {
      id: 'query-auth',
      text: 'authentication flow',
      embedding: [0.95, 0.05, 0],
      expectedFilePaths: ['/src/auth.ts'],
    },
    {
      id: 'query-db',
      text: 'database query',
      embedding: [0.1, 0.9, 0],
      expectedFilePaths: ['/src/db.ts'],
    },
    {
      id: 'query-ui',
      text: 'button component',
      embedding: [0.05, 0.1, 0.85],
      expectedFilePaths: ['/src/button.tsx'],
    },
  ],
} satisfies RetrievalGoldenDataset;
