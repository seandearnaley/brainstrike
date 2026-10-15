/**
 * Public entry for the thread context map (ADR-0021, BST-2017). Desktop
 * lazy-mounts `ThreadContextPage` from here. Nothing inside app-shell imports
 * this barrel; import the concrete module instead.
 */
export { ThreadContextPage, type ThreadContextPageProps } from './thread-context-page';
