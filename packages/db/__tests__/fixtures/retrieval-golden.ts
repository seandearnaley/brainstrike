export type RetrievalGoldenChunk = {
  id: string;
  content: string;
  embedding: number[];
};

export type RetrievalGoldenFile = {
  id: string;
  name: string;
  path: string;
  chunks: RetrievalGoldenChunk[];
};

export type RetrievalGoldenQuery = {
  id: string;
  text: string;
  embedding: number[];
  expectedFilePaths: string[];
};

export type RetrievalGoldenDataset = {
  embeddingSet: {
    modelKey: string;
    modelId: string;
    dimensions: number;
    distance: 'cosine' | 'dot' | 'l2';
  };
  files: RetrievalGoldenFile[];
  queries: RetrievalGoldenQuery[];
};

export const retrievalGoldenDataset = {
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
