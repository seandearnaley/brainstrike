# M2 native package integration — 2026-10-05

The full local Static sweep exposed missing registrations, coverage declarations,
public import boundaries, and stale config filenames in the newly introduced M2
packages. Native process tests already deliberately loaded compiled artifacts
through cross-package relative paths. Public exports now express that same seam,
with explicit integration build edges and first-match aliases. The source-alias
guard allowance is config- and specifier-scoped; its negative control proves an
ordinary config and an unrelated specifier still fail. The general boundary and
source guards remain active.

The Linux AppImage mocked lifecycle test compared a resolved macOS path with an
unresolved `/var` spelling. Resolving both operands preserves its same-directory
assertion, short socket-path bound, and alias cleanup proof. This unit correction
does not claim packaged Linux qualification.

The packaged Python command assertions follow the architecture-aware Node
launcher while retaining Electron node mode, physical executable and full-fence
controls. No packaging or signing campaign was added.

Selected real native integration tests exposed stale exact readiness shapes that
predated acknowledged publication receipts. The tests now retain exact readiness,
generation, and mutation assertions and check the additional receipt against the
actual intercepted writer plan, caller ticket, and acknowledged canonical file
set. Genuine aggregate failures remain scan-incomplete. No producer changed.
