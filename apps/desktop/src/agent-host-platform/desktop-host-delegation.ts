// Both launchers use the same persona scan, filtering and Core delegation settings.
export {
  type HostPersonaScan as DesktopPersonaScan,
  hostPersonaScan as desktopPersonaScan,
  resolveHostDelegation as resolveDesktopHostDelegation,
} from '@brainstrike/host-capabilities/delegation';
