// Export utilities
export * from './lib/utils';

// Export components
export * from './accordion';
export * from './badge';
export * from './button';
export * from './checkbox';
export * from './lightweight-checkbox';
export * from './dialog';
export * from './input';
export * from './label';
export * from './popover';
export * from './progress';
export * from './scroll-area';
export * from './select';
export * from './switch';
export * from './table';
export * from './tabs';
export * from './toast';
export * from './toaster';
export * from './tooltip';
export * from './loading-fallback';
export * from './error-fallback';
export * from './unsupported-feature';
export * from './navigation-sidebar';
export * from './theme-provider';
export * from './theme-toggle';
export * from './theme-settings';
export { default as RouterProvider } from './router-provider';
export type { RouterProviderProps } from './router-provider';

// Export hooks
export * from './use-toast';
export * from './hooks';
export type { PanelPersistenceState } from './hooks/use-panel-persistence';

// Export layout components
export * from './layout';
export { useIdeFileEditor } from './layout/ide-layout';

// Export types
export * from './types';

// Export ErrorBoundary
export { default as ErrorBoundary } from './error-boundary';
export type { ErrorBoundaryProps, ErrorBoundaryState } from './error-boundary';

// Export icon assets
export { default as icon16 } from '../icons/icon-16x16.png?url';
export { default as icon32 } from '../icons/icon-32x32.png?url';
export { default as icon48 } from '../icons/icon-48x48.png?url';
export { default as icon192 } from '../icons/icon-192x192.png?url';
export { default as icon512 } from '../icons/icon-512x512.png?url';
export { default as appleTouchIcon } from '../icons/apple-touch-icon.png?url';
