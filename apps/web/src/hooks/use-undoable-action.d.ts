interface UndoableActionOptions<T, S = unknown> {
    actionName: string;
    itemDescription: string;
    duration?: number;
    onUndo: (item: T, snapshot: S) => void;
    getStateSnapshot?: () => S;
}
export declare function useUndoableAction<T, S = unknown>(): {
    performUndoableAction: (key: string, item: T, options: UndoableActionOptions<T, S>) => void;
    clearUndoTimeout: (key: string) => void;
};
export {};
//# sourceMappingURL=use-undoable-action.d.ts.map