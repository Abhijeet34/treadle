# bench

The performance budget is enforced, not asserted: cold start against the runner's own Node
baseline, per-command p95 at 100, 1k, 10k and 50k items, peak memory, bundle size and the
measured output budget per command.

The corpora generator and the benchmark harness land with the store layer, which is the
first layer that has anything to measure.
