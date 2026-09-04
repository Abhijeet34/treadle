// SPDX-License-Identifier: Apache-2.0
// One shape for all twelve comparison axes, measured or not.
//
// `NOT MEASURED` is a value, not an absence: an axis that could not run carries the reason
// in the tool's own words and can never be read as a pass. Every measured axis carries the
// sample count and the operation count beside the figure, because a benchmark that ran zero
// operations reports the same shape as one that ran a thousand, and only the count separates
// them.

export type AxisVerdict = 'MET' | 'MISSED' | 'PARTIAL' | 'NOT MEASURED'

export type AxisResult = {
  readonly axis: string
  readonly name: string
  readonly metric: string
  readonly corpus: string
  readonly method: string
  /** The reference's measured value, quoted from the prior-art axes table, never re-derived. */
  readonly reference: string
  readonly target: string
  readonly verdict: AxisVerdict
  /** One line a reader can check. `NOT MEASURED: <reason>` when the verdict says so. */
  readonly observed: string
  /** Store operations this axis actually performed. Zero is the tell. */
  readonly operations: number
  readonly samples: number
  readonly detail?: unknown
  /** Named when the verdict is NOT MEASURED or PARTIAL: what has to land first. */
  readonly blockedOn?: string
}

export function notMeasured(
  partial: Omit<AxisResult, 'verdict' | 'observed' | 'operations' | 'samples'> & { readonly reason: string },
): AxisResult {
  const { reason, ...rest } = partial
  return {
    ...rest,
    verdict: 'NOT MEASURED',
    observed: `NOT MEASURED: ${reason}`,
    operations: 0,
    samples: 0,
  }
}
