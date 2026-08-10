/**
 * Single entry point for the collection debug drawer (BST-1214).
 *
 * Intentionally minimal: the panel imports `CollectionDebugDrawer` and nothing
 * else, so retiring the drawer is deleting this folder plus one JSX element.
 */

export { CollectionDebugDrawer } from './collection-debug-drawer';
export type { CollectionDebugDrawerProps } from './drawer-props';
