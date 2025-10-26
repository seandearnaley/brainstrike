#!/usr/bin/env node

import mermaid from 'mermaid';

const testDiagram = `flowchart LR
  subgraph UserSpace[End Users]
    U1[User]
  end

  subgraph Clients[Clients]
    W["Web App - Vite/React"]
    D["Desktop App - Electron"]
  end

  U1 -->|interacts| W
  U1 -->|interacts| D
`;

try {
  await mermaid.parse(testDiagram);
  console.log('✅ Diagram is valid!');
  process.exit(0);
} catch (error) {
  console.error('❌ Diagram has errors:');
  console.error(error.message);
  process.exit(1);
}
