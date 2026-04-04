/* c8 ignore file -- type definitions only */
import type { StoreApi, UseBoundStore } from 'zustand';

/** Zustand `set` function type for updating store state. */
export type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];

/** Zustand `get` function type for reading store state. */
export type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];
