// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F8. DR2 and DR8 set performance budgets and no ceilings, so a
// hostile committed shard or event log is parsed into memory with nothing to stop it. A
// budget says what should be fast; a ceiling says what is refused. Every number below is
// derived from a measurement in the design rather than picked, and each is stated with the
// measurement it comes from so a later change argues with the number rather than the taste.
//
// docs/architecture/adr/0002-storage-layout.md carries the same table for a reader who is
// not reading source.

/**
 * DR2 measured the largest shard of a 50,000-item corpus at 1,688 KB. Its own reopen
 * trigger is a month past about 5,000 items, which it puts at 4 MB. 8 MiB is twice that
 * trigger, so the layout is redesigned long before a legitimate workspace meets the cap.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

/** DR2's reopen trigger is 5,000 records in one month; 20,000 is four times it. */
export const MAX_RECORDS_PER_FILE = 20_000

/** The longest single-line field in the dictionary (2.14) is hold_reason at 500; 16x that. */
export const MAX_FIELD_VALUE_BYTES = 8 * 1024

/** 2.14's largest multi-line field is description at 100,000 characters. */
export const MAX_SECTION_BYTES = 128 * 1024

/** The dictionary names 21 common fields and at most 6 type fields; the rest is headroom. */
export const MAX_FIELDS_PER_RECORD = 256

/** 2.14 names six multi-line sections across every type. */
export const MAX_SECTIONS_PER_RECORD = 64

/**
 * DR2 measured a whole 50,000-item store's 500,000 events at 117.3 MB across 24 monthly
 * files. 256 MiB in one month is past any workspace that layout serves, and bounds the
 * rebuild a cloned repository can ask for.
 */
export const MAX_EVENT_FILE_BYTES = 256 * 1024 * 1024

/** DR2's whole-corpus event count is 500,000; four times it, in a single month. */
export const MAX_EVENTS_PER_FILE = 2_000_000

/** One event carries a before and an after snapshot; description alone caps at 100,000. */
export const MAX_EVENT_LINE_BYTES = 1024 * 1024

/** An event's before, after and guards are JSON of the store's own shapes: two deep. */
export const MAX_JSON_DEPTH = 32

export type Ceiling = {
  readonly name: string
  readonly limit: number
  readonly observed: number
}

/** Names the first ceiling an observation crosses, so a refusal can quote both numbers. */
export function exceeded(
  checks: readonly (readonly [string, number, number])[],
): Ceiling | undefined {
  for (const [name, observed, limit] of checks) {
    if (observed > limit) return { name, limit, observed }
  }
  return undefined
}
