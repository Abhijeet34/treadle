// SPDX-License-Identifier: Apache-2.0
// The one place a store and a mutation mode are paired. A `dry-run` gets the copy-on-write
// overlay, so every guard runs against a store that cannot write; every other mode gets the
// store it was handed. Pairing them here rather than at each call site is why a use case
// cannot be asked for a dry run and then given a store that writes.

import type { Store } from '../application/ports/store.ts'
import type { Mode, Target } from '../application/services/mutation.ts'
import { OverlayStore } from './store/index.ts'

export function targetFor(store: Store, mode: Mode): Target {
  return mode === 'dry-run' ? { store: new OverlayStore(store), mode } : { store, mode }
}
