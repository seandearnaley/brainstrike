# Migration Notes

## Removal of In-Browser Git Analysis (YYYY-MM-DD)

The BrainStrike application no longer includes the built-in Git analysis features (history, comparison) that relied on the `isomorphic-git` library.

- **Reason**: To simplify the frontend bundle, remove Node.js polyfills, and reduce maintenance overhead.
- **Impact**: The Git-related tabs and functionality have been removed from the Context Explorer.
- **Future**: If Git analysis features are needed in the future, they will likely rely on external services or backend APIs rather than in-browser processing. 