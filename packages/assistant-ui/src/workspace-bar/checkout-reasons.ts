/**
 * Why checkout mode is unavailable for a folder a settled git status read says
 * is not a repository. App-shell's worktree mode writes it; the where-control
 * names such a folder with no checkout and no warning, and warns about any
 * other unavailable reason.
 */
export const NOT_A_GIT_REPOSITORY_REASON = 'Not a git repository';
