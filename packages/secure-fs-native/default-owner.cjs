'use strict';

// BST-2246: a Windows process entry that can create host-lease or state-store
// objects imports this module first, so everything the process creates gets the
// current user as owner, even in an elevated session whose token defaults to
// BUILTIN\Administrators. A failure throws here, at the entry's first import:
// the process never continues with another default owner. A no-op on POSIX.
require('./index.cjs').setDefaultOwnerToCurrentUserSync();
