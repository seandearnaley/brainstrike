declare module '@brainstrike/app-shell/navigation' {
  // Lightweight shim for desktop renderer type-check; runtime resolves via Vite alias
  export const navigationItems: unknown;
}

declare module '@brainstrike/app-shell/root-layout-content' {
  export const RootLayoutContent: React.ComponentType;
}

declare module '@brainstrike/app-shell/settings-page-content' {
  export const SettingsPageContent: React.ComponentType;
}

declare module '@brainstrike/app-shell' {
  export const navigationItems: unknown;
  export const RootLayoutContent: React.ComponentType;
  export const SettingsPageContent: React.ComponentType;
}
