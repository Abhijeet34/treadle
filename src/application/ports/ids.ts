// SPDX-License-Identifier: Apache-2.0
// The id-generator seam (DR6). Transaction and event ids are minted here; an item id is a
// slug of its title and is derived rather than minted, so it stays readable in a file a
// person reviews. Two implementations ship: a random suffix, and a sequential one that is
// what makes a golden result object and a `--dry-run` diff byte-stable.

export interface IdGenerator {
  /** The id every write of one command shares, and the one a `history` read resolves (R4). */
  txn(): string
  event(): string
}
