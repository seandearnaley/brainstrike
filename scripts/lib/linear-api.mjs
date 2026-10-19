// The Linear GraphQL client the nightly scripts share (BST-1915, BST-2189):
// scripts/notify-linear-nightly.mjs and scripts/nightly-fix-issue.mjs. Zero
// dependencies: Node's native fetch. The key travels only in the Authorization
// header, and no error message carries it.

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const ERROR_BODY_LIMIT = 500;

export function createLinearClient(fetchImpl, apiKey) {
  return async function request(query, variables = {}) {
    // Personal API keys are sent raw: no `Bearer` prefix.
    const response = await fetchImpl(LINEAR_ENDPOINT, {
      body: JSON.stringify({ query, variables }),
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, ERROR_BODY_LIMIT);
      throw new Error(`Linear API returned HTTP ${response.status}: ${detail}`);
    }
    const payload = await response.json();
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const messages = payload.errors.map((error) => error?.message ?? 'unknown error');
      throw new Error(`Linear API returned errors: ${messages.join('; ')}`);
    }
    if (typeof payload.data !== 'object' || payload.data === null) {
      throw new Error('Linear API response carried no data.');
    }
    return payload.data;
  };
}

export function nodesOf(data, field) {
  const nodes = data[field]?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(`Linear API response is missing ${field}.nodes.`);
  }
  return nodes;
}

export function exactlyOne(nodes, description) {
  if (nodes.length === 0) {
    throw new Error(`Linear has no ${description}.`);
  }
  if (nodes.length > 1) {
    throw new Error(`Linear has ${nodes.length} ${description}; expected exactly one.`);
  }
  return nodes[0];
}

export function assertSucceeded(payload, field) {
  if (payload[field]?.success !== true) {
    throw new Error(`Linear ${field} did not report success.`);
  }
  return payload[field];
}

/** Follows a connection's pages; `pageOf` returns `{ nodes, pageInfo }` or undefined. */
export async function allPages(fetchPage, pageOf, what) {
  const nodes = [];
  let cursor = null;
  do {
    const page = pageOf(await fetchPage(cursor));
    if (!(Array.isArray(page?.nodes) && page.pageInfo)) {
      throw new Error(`Linear API response is missing ${what}.`);
    }
    nodes.push(...page.nodes);
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new Error(`Linear reported more ${what} but no cursor.`);
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return nodes;
}
