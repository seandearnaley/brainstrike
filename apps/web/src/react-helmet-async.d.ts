// Type augmentation for react-helmet-async compatibility with React 19.2+
// The library types haven't been updated for React 19's stricter JSX component types
// See: https://react.dev/blog/2024/04/25/react-19#new-jsx-transform

declare module 'react-helmet-async' {
  import type { Component, ReactNode } from 'react';

  export interface HelmetProps {
    async?: boolean;
    base?: Record<string, unknown>;
    bodyAttributes?: Record<string, unknown>;
    children?: ReactNode;
    defaultTitle?: string;
    defer?: boolean;
    encodeSpecialCharacters?: boolean;
    htmlAttributes?: Record<string, unknown>;
    link?: Record<string, unknown>[];
    meta?: Record<string, unknown>[];
    noscript?: Record<string, unknown>[];
    onChangeClientState?: (newState: unknown, addedTags: unknown, removedTags: unknown) => void;
    prioritizeSeoTags?: boolean;
    script?: Record<string, unknown>[];
    style?: Record<string, unknown>[];
    title?: string;
    titleAttributes?: Record<string, unknown>;
    titleTemplate?: string;
  }

  export class Helmet extends Component<HelmetProps> {}

  export interface ProviderProps {
    children?: ReactNode;
    context?: unknown;
  }

  export class HelmetProvider extends Component<ProviderProps> {}

  export const HelmetData: unknown;
  export const HelmetServerState: unknown;
}
