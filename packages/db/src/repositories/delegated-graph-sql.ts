// Walk outward from the authorized root. Checking only the requested node
// would leave grandchildren accessible after an intermediate scope changed.
export const AUTHORIZED_DELEGATED_GRAPH = `WITH RECURSIVE owned_nodes AS (
  SELECT node.*, 0 AS delegation_depth FROM brainstrike_delegated_conversations node
  JOIN mastra_threads native ON native.id = node.thread_id AND native."resourceId" = node.resource_id
  WHERE node.owner_resource_id = $1 AND node.thread_id = $2
    AND node.root_thread_id = $2 AND node.parent_thread_id IS NULL
  UNION ALL
  SELECT node.*, parent.delegation_depth + 1 AS delegation_depth FROM brainstrike_delegated_conversations node
  JOIN owned_nodes parent ON node.parent_thread_id = parent.thread_id
  JOIN mastra_threads native ON native.id = node.thread_id AND native."resourceId" = node.resource_id
  WHERE node.owner_resource_id = $1 AND node.root_thread_id = $2
)`;
