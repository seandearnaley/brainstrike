// Type augmentation for react-helmet-async compatibility with React 19.2+
// The library types haven't been updated for React 19's stricter JSX component types
// See: https://react.dev/blog/2024/04/25/react-19#new-jsx-transform

declare module 'react-helmet-async' {
  import type { Component, ReactNode } from 'react';

  export interface HelmetProps {
    async?: boolean;
    base?: Record<string, unknown>;
    bodyAttributes?: Record<string, unknown>;
    defaultTitle?: string;
    defer?: boolean;
    encodeSpecialCharacters?: boolean;
    htmlAttributes?: Record<string, unknown>;
    onChangeClientState?: (newState: unknown, addedTags: unknown, removedTags: unknown) => void;
    link?: Array<Record<string, unknown>>;
    meta?: Array<Record<string, unknown>>;
    noscript?: Array<Record<string, unknown>>;
    script?: Array<Record<string, unknown>>;
    style?: Array<Record<string, unknown>>;
    title?: string;
    titleAttributes?: Record<string, unknown>;
    titleTemplate?: string;
    prioritizeSeoTags?: boolean;
    children?: ReactNode;
  }

  export class Helmet extends Component<HelmetProps> {}

  export interface ProviderProps {
    context?: unknown;
    children?: ReactNode;
  }

  export class HelmetProvider extends Component<ProviderProps> {}

  export const HelmetData: unknown;
  export const HelmetServerState: unknown;
}
