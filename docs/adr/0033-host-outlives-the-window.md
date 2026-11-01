# ADR-0033: The host outlives the window, not the app

- **Status:** Accepted (Sean, 2026-11-01: option 1, "Yes, on all platforms")
- **Date:** 2026-11-01
- **Ticket:** BST-2432
- **Related:** [ADR-0008](0008-capability-based-feature-gating.md) (capability gating),
  [ADR-0015](0015-desktop-platform-ipc-reset-diagnostics.md) and
  [ADR-0020](0020-greenfield-data-lifecycle.md) (reset), ADR 0026, 0027 and 0030 (joined
  quit, unchanged), [host lease](../agents/host-lease.md) (`HostLifetime`, unchanged); BST-2394

## Context

On Windows and Linux, closing the last window quit the app (`lastWindowQuits` in Main). The
host is app-owned, so a run under way ended with "Host is closing" (BST-2394). macOS kept the
app running in the Dock.

Three options were weighed:

1. The app keeps running in a tray after its last window closes. No lifecycle ADR changes.
2. The desktop starts a persistent host and attaches to it. That needs L1 and changes ADRs
   0026 and 0030, the host lease and reset.
3. An OS service at login: option 2 plus a per-OS install.

## Decision

Option 1.

1. **Closing the last window keeps the app running** where something keeps it reachable:
   - macOS: the Dock and app menu, as before.
   - Windows: a tray icon (Electron `Tray`), always.
   - Linux: a tray icon where a StatusNotifierItem host is registered on the session bus.
   - The window still closes through its document unload (ADR-0026 R1).
2. **Linux tray support is an injected capability** (ADR-0008). Main asks the session bus
   (`gdbus`, `IsStatusNotifierHostRegistered`). Where no tray can show (stock GNOME, an
   XEmbed-only tray, no bus), closing the last window still quits, so no one is left without a
   window or an icon. Settings says why.
3. **Settings › Startup** has two switches, both owned by Main:
   - "Keep running in the tray when closed", on by default, in the desktop settings store
     (`brainstrike-settings`).
   - "Open at login", off by default. The OS holds this fact (`app.setLoginItemSettings` on
     macOS and Windows), so Main reads it back and stores no copy. A login launch starts
     without a window where the Dock or the tray keeps the app reachable. Linux has no
     canonical login item for an AppImage, so the switch is shown as unavailable there, as it
     is in a copy that was not installed.
4. **The tray menu is static and shows no run status.** On Windows and Linux it is the same
   "Open Brainstrike" and "Quit Brainstrike", built once when the icon shows; a click on the
   icon opens a window, and Quit is today's joined quit. The tray never reads the host, so a
   host that is starting, hung or wedged cannot stop the menu from opening or put Quit out of
   reach. Run status belongs in the window and in OS notifications.
5. **The first close to the tray shows one notice** that Brainstrike is still running. Its
   "shown" flag lives in the desktop settings store, which factory reset deletes with userData.
   A second launch while the app runs in the tray opens a window.
6. **Unchanged:** the host lease, the supervisor, factory reset, and quit and its order. The
   host stays app-owned.

## Consequences

- Main, the host and the indexer stay resident with no window. Idle memory with no window open
  is measured in the PR that ships this. No idle-shutdown timer is added.
- The tray adds no idle work and no new failure path: it never reads the host. A tray icon
  that cannot show makes the last close quit.
- Someone who closed the window learns what is running by opening it, or from an OS
  notification; the tray does not say.
- Factory reset leaves the OS login item in place: Settings reads it back from the OS.
- Deferred: remote and phone clients, and runs that survive Quit (option 2, after L1, when a
  feature needs them).
