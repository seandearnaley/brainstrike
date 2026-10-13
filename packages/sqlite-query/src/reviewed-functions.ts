// The SQL functions grep's fixed statements invoke, measured on SQLite 3.53
// over every recorded grep pattern shape (BST-1997). Every other function,
// including any a future grep statement adds, is denied until reviewed here.
export const REVIEWED_FUNCTIONS = new Set<string>(['instr', 'length', 'lower', 'match', 'typeof']);
