// SPDX-License-Identifier: Apache-2.0
// The store adapter's public surface: the two implementations of the seam in
// src/application/ports/store.ts, and the pieces a later layer needs by name.

export {
  FILE_MODE,
  DIR_MODE,
  TEMP_SWEEP_MS,
  appendAndSync,
  isTempName,
  sweepTempFiles,
  tempNameFor,
  writeFileAtomic,
} from './atomic.ts'

export {
  eventIdsInTail,
  parseEventLine,
  renderEvent,
  scanEventFile,
  type EventScan,
} from './event-log.ts'

export {
  parseFile,
  parseRecordSource,
  renderFile,
  renderHeader,
  renderRecord,
  sourceOf,
  unwritableBodyLine,
  type Chunk,
  type ParsedFile,
  type ParsedRecord,
  type QuarantinedRecord,
  type Section,
} from './grammar.ts'

export { IndexCache, type Fingerprint, type IndexedItem } from './index-cache.ts'

export { decodeItem, encodeItem, STRUCTURAL_NOW } from './item-codec.ts'

export * from './limits.ts'

export {
  HEARTBEAT_MS,
  STALE_MS,
  acquireLock,
  processIsGone,
  type AcquireOptions,
  type LockHandle,
  type LockToken,
} from './lock.ts'

export { OverlayStore, type Pending } from './overlay-store.ts'

export {
  SCHEMA,
  ShardedStore,
  WORKSPACE_FILE,
  createWorkspace,
  openWorkspace,
  resolveWorkspace,
  type ShardedStoreOptions,
} from './sharded-store.ts'
