## 2024-05-01 - Avoid template string allocations in hot path tree traversal
**Learning:** Checking for path descendants in hot loops (e.g., `targetPath.startsWith(`${node.path}/`)`) causes excessive string allocations and slows down tree traversal significantly when dealing with large trees.
**Action:** Replace template string checks with length and character code checks (`targetPath.length > node.path.length && targetPath.charCodeAt(node.path.length) === 47 && targetPath.startsWith(node.path)`). This avoids allocating intermediate strings and provides a >2x performance improvement.
