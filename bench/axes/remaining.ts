// SPDX-License-Identifier: Apache-2.0
// The two axes this rig still cannot fill, each carrying the method it will be measured by
// so the next task inherits a harness rather than a paragraph.
//
// Both are NOT MEASURED with the reason stated. Neither is estimated, interpolated or left
// out, because a table with a gap in it reads as a pass to whoever skims it. The six that
// used to sit here moved out when the command surface got a harness that drives it; what
// remains needs a product that does not exist yet, which is a different kind of absence and
// is not closed by writing more harness.

import { notMeasured, type AxisResult } from './axis.ts'

export function remainingAxes(): readonly AxisResult[] {
  return [
    notMeasured({
      axis: 'A9', name: 'Metric coverage',
      metric: 'metrics computable with an exact printed formula',
      corpus: 'the fourteen flow metrics in the domain model',
      method: 'run each on a seeded store and compare against a spreadsheet',
      reference: '0 of 14',
      target: '14 of 14, each matching the spreadsheet',
      reason: 'no metric is implemented in this tree; nothing under src computes velocity, cycle time or a burndown series, so there is nothing to score and a figure here would be a figure about a harness',
      blockedOn: 'the metrics layer, which no landed commit begins',
    }),
    notMeasured({
      axis: 'A11', name: 'Harness neutrality',
      metric: "files under a harness's home directory the tool writes or requires",
      corpus: 'the three harness homes the reference knows',
      method: 'run the full feature set with no harness present and count files written',
      reference: 'setup writes 4 files across 3 harnesses',
      target: '0 required; adapters optional and generated',
      reason: 'the target has two halves and one of them has nothing to score: no adapter generator exists, because ADR-0012 refuses A.8 rule 3 for v1, so "adapters optional and generated" cannot be measured at all. The counting half is now reachable through the same harness the other axes use and is not run here rather than being reported half done',
      blockedOn: 'an adapter generator to score, which ADR-0012 refuses for v1',
    }),
  ]
}
