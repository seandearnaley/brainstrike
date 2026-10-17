/**
 * BST-1932: one admission's platform selection is held by the run that
 * acquired it and by every child run that borrows that admission. Each holder
 * releases once; the selection closes once, after the last holder released.
 * A background child therefore keeps its root's selection open after the root
 * run finishes (AT-06: its approved write otherwise found "no admitted
 * capabilities"), while the root's next run acquires a selection of its own.
 */
interface HostAdmissionLease {
  readonly close: () => Promise<void> | void;
  closing?: Promise<void>;
  holders: number;
}

// Keyed by each holder's release function: the admission object is spread as a
// run binds it, but its `close` is carried over unchanged.
const leases = new WeakMap<() => Promise<void>, HostAdmissionLease>();

function closeLease(lease: HostAdmissionLease): Promise<void> {
  const closing = Promise.resolve().then(() => lease.close());
  lease.closing = closing;
  return closing;
}

function hold(lease: HostAdmissionLease): () => Promise<void> {
  if (lease.closing !== undefined) {
    throw new Error('A released admission cannot be borrowed');
  }
  lease.holders += 1;
  let released: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (!released) {
      lease.holders -= 1;
      released = lease.holders === 0 ? closeLease(lease) : Promise.resolve();
    }
    return released;
  };
  leases.set(release, lease);
  return release;
}

/** The acquiring run's release of a newly captured selection: its first holder. */
export function leaseHostAdmission(close: () => Promise<void> | void): () => Promise<void> {
  return hold({ close, holders: 0 });
}

/**
 * Another holder of the selection behind `close` (a parent admission's
 * release), or nothing when that admission owns no selection.
 */
export function borrowHostAdmission(
  close: (() => Promise<void>) | undefined
): (() => Promise<void>) | undefined {
  if (!close) {
    return;
  }
  const lease = leases.get(close);
  if (!lease) {
    throw new Error('A child can borrow only a captured admission');
  }
  return hold(lease);
}
