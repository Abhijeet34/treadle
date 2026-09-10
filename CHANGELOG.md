# Changelog

## [0.2.2](https://github.com/Abhijeet34/treadling/compare/v0.2.1...v0.2.2) (2026-09-10)


### Documentation

* correct docs now that @abhijeet34/treadling is published, without implying the pipeline publishes it ([#106](https://github.com/Abhijeet34/treadling/issues/106)) ([be49583](https://github.com/Abhijeet34/treadling/commit/be495838273de4ced4e98977ab5ad83b48a877f0))

## [0.2.1](https://github.com/Abhijeet34/treadling/compare/v0.2.0...v0.2.1) (2026-09-10)


### Bug Fixes

* publish the package under the scoped name @abhijeet34/treadling ([#104](https://github.com/Abhijeet34/treadling/issues/104)) ([4eaaf46](https://github.com/Abhijeet34/treadling/commit/4eaaf463af0804854c81648f52aed6143f6ab730))

## [0.2.0](https://github.com/Abhijeet34/treadling/compare/v0.1.3...v0.2.0) (2026-09-10)


### ⚠ BREAKING CHANGES

* the executable is `treadling`, every `TREADLE_*` environment variable is now `TREADLING_*`, and no package was ever published under the old name.

### Bug Fixes

* rename the package and command from treadle to treadling ([#102](https://github.com/Abhijeet34/treadling/issues/102)) ([04e6972](https://github.com/Abhijeet34/treadling/commit/04e6972dd19dfbb86950a5b47993a733e5f966ec))

## [0.1.3](https://github.com/Abhijeet34/treadle/compare/v0.1.2...v0.1.3) (2026-09-10)


### Bug Fixes

* **release:** stop the artifacts job creating a second GitHub release ([#100](https://github.com/Abhijeet34/treadle/issues/100)) ([ed7172b](https://github.com/Abhijeet34/treadle/commit/ed7172b5ca94b8ec10b3058b214742ecd0de571d))

## [0.1.2](https://github.com/Abhijeet34/treadle/compare/v0.1.1...v0.1.2) (2026-09-10)


### Build and release

* **release:** cut the tag from the run and approve its parked checks ([#97](https://github.com/Abhijeet34/treadle/issues/97)) ([b55ce5c](https://github.com/Abhijeet34/treadle/commit/b55ce5c550e1b23651ba38e80598ef8cac6d8047))

## [0.1.1](https://github.com/Abhijeet34/treadle/compare/v0.1.0...v0.1.1) (2026-09-10)


### Bug Fixes

* **ci:** recognize Node's option-object test skip and run the secret-scan proof in CI ([#93](https://github.com/Abhijeet34/treadle/issues/93)) ([ccc32bc](https://github.com/Abhijeet34/treadle/commit/ccc32bc3401f98a2f2a15b2feade02391868d970))
* **release:** remove the private flag and correct release-truth claims ([#96](https://github.com/Abhijeet34/treadle/issues/96)) ([ec9ccbe](https://github.com/Abhijeet34/treadle/commit/ec9ccbef1190a292f9d6f47eb3eb942b2e0334a4))
* **store:** wait out an EPERM from an exclusive create when the directory still takes a file ([#94](https://github.com/Abhijeet34/treadle/issues/94)) ([6d82d10](https://github.com/Abhijeet34/treadle/commit/6d82d10d2f2532ffe10ae7b863aeeb6247c9053c))

## 0.1.0 (2026-09-10)


### ⚠ BREAKING CHANGES

* **domain:** `reporter` is no longer a work-item field. `show` emits schema `show/3` without it, a gate rule reading it is refused `V6`, and `set <id> reporter=` is refused `V5`.
* **store:** `S14`, the rule for two events sharing an id, is gone with the table that owned it, and both copies of a repeated event id are now served. A damaged event line no longer refuses `status` or `backlog`; it refuses `history`, `explain` and `doctor`, which are the reads that answer from the log. The `.index/` directory is neither read nor written, and the transaction journal is at `.txn/`; a workspace written by an earlier build reads unchanged and its `.index/` is inert.
* **cut:** `sprint`, `sprints`, `ceremonies` and `board` are gone, as are `--points`, `--sprint`, `--preview`, `--color` and `--no-input`, the `points`, `hours_estimate`, `timebox_hours`, `sprint_id` and `component` fields, guard `G4`, gate rule `DOR5`, doctor findings `H26`, `H28` and `H29`, and the `point_scale`, `cycle_time_excludes_hold` and `start_requires_sprint` configuration keys. Fourteen result schemas move: `backlog` and `status` to v3, and `config`, `evidence`, `explain`, `file`, `init`, `mark`, `next`, `relation`, `remove`, `set`, `show` and `transition` to v2. A record written by an earlier build still reads.
* **cli:** a single-valued flag written twice on one line is now VALIDATION at exit 2 where it exited 0 and used the last value, and a column named twice in --fields is the same refusal. Write the flag once, and name each column once; the refusal offers the de-duplicated line.
* **status:** the status result object no longer declares absent_features, and its schema id is status/2.
* **sprint:** `file --sprint <id>` now refuses an id that names no open sprint and an item that cannot enter one (I2, I4); it stored any string before. `set <id> sprint_id=` is refused in favour of `treadle sprint commit`.
* **store:** close the lock, symlink, and event-log gaps found in the second adversarial pass ([#29](https://github.com/Abhijeet34/treadle/issues/29))
* **cli:** a command run against a store that holds a record it cannot serve exits 7 where it exited 0 with the record missing from its count, `doctor` exits 7 with findings where it exited 0, and a domain integrity error exits 7 where it exited 6. Nothing is released; these are release notes under docs/STABILITY.md rather than a bump.
* **cli:** with no command word, any global flag the tool cannot honour is now refused instead of being silently dropped. On d1a9391 `treadle --out` (a value missing) and `treadle --quiet=1` (a value on a boolean) both exited 0 and ran the default `status` command with the flag dropped or misparsed; both now exit 2, with `--out needs a value` and `--quiet takes no value`. `treadle --nope` exits 2 with `--nope is not a flag of treadle`. docs/STABILITY.md calls a new non-zero exit for a case that used to succeed breaking, and release-please-config.json sets `bump-minor-pre-major: true`, so this bumps the minor.

### Features

* add label filters, sprint editing, title search, and item removal ([#55](https://github.com/Abhijeet34/treadle/issues/55)) ([91916bf](https://github.com/Abhijeet34/treadle/commit/91916bf8a31ef397ff63433f15d5bcde1fe7eb34))
* **board:** add board as a projection of the backlog by state ([#37](https://github.com/Abhijeet34/treadle/issues/37)) ([4b2875d](https://github.com/Abhijeet34/treadle/commit/4b2875dcd30c5b081170bdc35271129ff3b59f02))
* **cli:** add history --txn to list a transaction's events ([#61](https://github.com/Abhijeet34/treadle/issues/61)) ([3bd8b1f](https://github.com/Abhijeet34/treadle/commit/3bd8b1f5e5d29ba4977452dae10b7590feca4e4f))
* **cli:** add set command and unify the description/desc field name ([#24](https://github.com/Abhijeet34/treadle/issues/24)) ([02251fa](https://github.com/Abhijeet34/treadle/commit/02251facd167ad45d25d730aa0c53e395205ce38))
* **cli:** add treadle's runnable command surface with output contract and renderers ([#3](https://github.com/Abhijeet34/treadle/issues/3)) ([7da36b0](https://github.com/Abhijeet34/treadle/commit/7da36b0817e5e23b7e8f2bd76cadb03b6a81f2e3))
* **cli:** audit severity/priority changes and bound evidence with doctor checks ([#13](https://github.com/Abhijeet34/treadle/issues/13)) ([3614049](https://github.com/Abhijeet34/treadle/commit/3614049f4f23d5b54cf4aff4eff2ab02822cdf76))
* **cli:** default backlog to open items and refuse actorless writes ([#78](https://github.com/Abhijeet34/treadle/issues/78)) ([7356b89](https://github.com/Abhijeet34/treadle/commit/7356b89c1e24acc2da9e8a8141cdbde228905c4e))
* **cli:** print help vocabulary once and state actor attribution honestly ([#79](https://github.com/Abhijeet34/treadle/issues/79)) ([0ef658a](https://github.com/Abhijeet34/treadle/commit/0ef658af12e3b26745408fe05606fb214cc7a2d5))
* **cli:** surface actor history and sweep hidden persisted fields ([#21](https://github.com/Abhijeet34/treadle/issues/21)) ([7ca95a0](https://github.com/Abhijeet34/treadle/commit/7ca95a0c9db38da871f1dfcb67f9e076b57c976f))
* **config:** add workspace configuration and its six consumers ([#62](https://github.com/Abhijeet34/treadle/issues/62)) ([9498d41](https://github.com/Abhijeet34/treadle/commit/9498d41874b780d04fa5808affc7633c1ffdc321))
* **domain:** add cancel resolutions, release outcomes, due dates and reviewability markers ([#11](https://github.com/Abhijeet34/treadle/issues/11)) ([d965cb8](https://github.com/Abhijeet34/treadle/commit/d965cb8b3e428164f09bb52c2928d87f80121faf))
* **domain:** retire reporter field and fix stale doc pointers ([#80](https://github.com/Abhijeet34/treadle/issues/80)) ([37fc11a](https://github.com/Abhijeet34/treadle/commit/37fc11aeb7a31516c4a6e876e4514211ada6a01f))
* **impediment:** add a blocker type that must say what would clear it ([#36](https://github.com/Abhijeet34/treadle/issues/36)) ([cc3fc6d](https://github.com/Abhijeet34/treadle/commit/cc3fc6dc8777a9c0f8f72dfd8c6bac1747c15adb))
* **relation:** add typed links between items with guards, doctor findings, and derived reads ([#34](https://github.com/Abhijeet34/treadle/issues/34)) ([8d8d33d](https://github.com/Abhijeet34/treadle/commit/8d8d33dfd63642c721fa56d619e2776d10080f35))
* **release:** report the publication decision on every release ([#91](https://github.com/Abhijeet34/treadle/issues/91)) ([391237c](https://github.com/Abhijeet34/treadle/commit/391237c4250a1ec627e83e975d1c2b612b6b2fda))
* **sprint:** add sprint lifecycle with commit tracking and carry-over ([#35](https://github.com/Abhijeet34/treadle/issues/35)) ([fbab9fb](https://github.com/Abhijeet34/treadle/commit/fbab9fb1b602900f0bf791521d5208157afe2beb))
* **status:** drop absent_features and guard against a re-added harness instruction file ([#39](https://github.com/Abhijeet34/treadle/issues/39)) ([9888781](https://github.com/Abhijeet34/treadle/commit/9888781983089880002802aee5e4334206aba5ea))
* **store:** add sharded record store with durability and overlay seam ([#2](https://github.com/Abhijeet34/treadle/issues/2)) ([c4fb9a1](https://github.com/Abhijeet34/treadle/commit/c4fb9a1e108862eb5f5e53c2dfebac872f92e898))
* **store:** the retrospective as a record kind of its own ([#63](https://github.com/Abhijeet34/treadle/issues/63)) ([c2a326f](https://github.com/Abhijeet34/treadle/commit/c2a326f79cad53f45575fc473c98483adcbf02fd))


### Bug Fixes

* **application:** fix criteria readback and history echo defects ([#28](https://github.com/Abhijeet34/treadle/issues/28)) ([6a8f012](https://github.com/Abhijeet34/treadle/commit/6a8f0125fa424a02caef75bbf2e6035d672fbcfd))
* **bench:** fix pagination, doctor scale, and extensibility defects found by stress benchmarking ([#30](https://github.com/Abhijeet34/treadle/issues/30)) ([3bce1ca](https://github.com/Abhijeet34/treadle/commit/3bce1ca400b6b6bb1989b29f3ad8242415f69280))
* **bench:** key corpus isolation to run id and pid by default ([#49](https://github.com/Abhijeet34/treadle/issues/49)) ([feb9fcd](https://github.com/Abhijeet34/treadle/commit/feb9fcd84dfb7df1116424686a396771597e733d))
* clear round-six publish blockers for signed-tag release ([#54](https://github.com/Abhijeet34/treadle/issues/54)) ([d92f361](https://github.com/Abhijeet34/treadle/commit/d92f3617ac1f464b100dfdc7721a52c3e7eebc0a))
* **cli:** bound operands, close conflicting-field gaps, and correct self-description ([#70](https://github.com/Abhijeet34/treadle/issues/70)) ([83d799c](https://github.com/Abhijeet34/treadle/commit/83d799cddee7313344ab44056777dbe4daf8c4e6))
* **cli:** close four live interface defects in history, backlog, and parsing ([#26](https://github.com/Abhijeet34/treadle/issues/26)) ([0286e42](https://github.com/Abhijeet34/treadle/commit/0286e42eea2233c2f768b5bba966ddd16672cb86))
* **cli:** give every unavailable-store refusal its own fix line ([#83](https://github.com/Abhijeet34/treadle/issues/83)) ([b9c5ad2](https://github.com/Abhijeet34/treadle/commit/b9c5ad2b1f74d46d9fc5511a96248f16e317daa6))
* **cli:** guard operand delimiters, reject silent flag/column repeats, fix past-sprint day ([#56](https://github.com/Abhijeet34/treadle/issues/56)) ([52616bc](https://github.com/Abhijeet34/treadle/commit/52616bc9c3b418515c31f7140829744621cd6e7b))
* **cli:** honor --out json for refusals raised before flag parsing ([#40](https://github.com/Abhijeet34/treadle/issues/40)) ([f8e5a4c](https://github.com/Abhijeet34/treadle/commit/f8e5a4cc16bb3465e6bd6e6265e02e1af7f52b43))
* **cli:** make transition guards, effects and flags match what treadle tells callers ([#45](https://github.com/Abhijeet34/treadle/issues/45)) ([9c5fc59](https://github.com/Abhijeet34/treadle/commit/9c5fc59d7534391ea68997ead7ed95e85ab00f51))
* **cli:** refuse reads over corrupt records and hold the width contract ([#27](https://github.com/Abhijeet34/treadle/issues/27)) ([5a78152](https://github.com/Abhijeet34/treadle/commit/5a78152be75f2a152127529b79b8b8dcfd949881))
* **cli:** stop doctor's dead-end remedy and document resume as a transition target ([#86](https://github.com/Abhijeet34/treadle/issues/86)) ([5492519](https://github.com/Abhijeet34/treadle/commit/54925192f996a27c8009f3c67562d2c6ee3a4e48))
* close eight defects found by driving treadle's command surface ([#4](https://github.com/Abhijeet34/treadle/issues/4)) ([d5dd734](https://github.com/Abhijeet34/treadle/commit/d5dd734e337aef385230aac1ec4ce308d334d8b4))
* **cut:** remove treadle's agile surface and re-derive its docs ([#65](https://github.com/Abhijeet34/treadle/issues/65)) ([1bc0049](https://github.com/Abhijeet34/treadle/commit/1bc0049f795b95dcd0284388ff2465f2721430f9))
* **doctor:** close four ways a damaged workspace read clean, and refuse self-accept ([#77](https://github.com/Abhijeet34/treadle/issues/77)) ([32aa319](https://github.com/Abhijeet34/treadle/commit/32aa319c3cb2c1d4da386271177ac6aee7e39fe7))
* **doctor:** stop the audit lying about who accepted and what went missing ([#82](https://github.com/Abhijeet34/treadle/issues/82)) ([58eb674](https://github.com/Abhijeet34/treadle/commit/58eb67485a1403faaf4ee3ac4c355ed7b4a084dd))
* **domain:** sweep truth-audit defects and fold chore into task ([#75](https://github.com/Abhijeet34/treadle/issues/75)) ([1a0fc77](https://github.com/Abhijeet34/treadle/commit/1a0fc77b7b99bc148d7acf798f6025c28982ae26))
* epics skip review/ranking; status reports an unwritable store ([#84](https://github.com/Abhijeet34/treadle/issues/84)) ([e1f59cb](https://github.com/Abhijeet34/treadle/commit/e1f59cb56ba6e0870ce703f7cd6f405b334cf2ea))
* freeze closed-sprint tallies and close treadle's round-five audit findings ([#53](https://github.com/Abhijeet34/treadle/issues/53)) ([787fa86](https://github.com/Abhijeet34/treadle/commit/787fa8630d658ba4df3d1d42bebee81e2b6854e7))
* **gates:** DOD3 stops reading who runs the accept, H34 reports single-actor completion ([#88](https://github.com/Abhijeet34/treadle/issues/88)) ([f3868c8](https://github.com/Abhijeet34/treadle/commit/f3868c820a097d2b24943fe41388825556fb0050))
* harden treadle's entry points, refusals, and release packing against six measured defects ([#52](https://github.com/Abhijeet34/treadle/issues/52)) ([c8fd485](https://github.com/Abhijeet34/treadle/commit/c8fd485fe981db56255a63b7b3603d84aca959b4))
* **hierarchy:** guard parent writes and clear fields by empty value ([#44](https://github.com/Abhijeet34/treadle/issues/44)) ([5444209](https://github.com/Abhijeet34/treadle/commit/5444209424539a61f60f2e945ee4e749923c81d6))
* **relation:** guard concurrent cycle writes and close adjacent validation gaps ([#38](https://github.com/Abhijeet34/treadle/issues/38)) ([40c3f30](https://github.com/Abhijeet34/treadle/commit/40c3f30853d44d2017526d45fcd2b38488be719f))
* **release:** stop parked release checks from failing main ([#76](https://github.com/Abhijeet34/treadle/issues/76)) ([6371fbc](https://github.com/Abhijeet34/treadle/commit/6371fbc1db731b3788e0f47d6f60ec1880c7be3f))
* **release:** unblock the release pull request from startup failure through to merge ([#68](https://github.com/Abhijeet34/treadle/issues/68)) ([cc5ab6c](https://github.com/Abhijeet34/treadle/commit/cc5ab6cee99ed9e70032a6b5f5b1c98662a04b9f))
* **remedy:** make every printed page, cursor and remedy line runnable as printed ([#42](https://github.com/Abhijeet34/treadle/issues/42)) ([1879286](https://github.com/Abhijeet34/treadle/commit/187928658005529379f41d4af13537374f60ceb0))
* **render:** move root-level scalars ahead of blocks in every command's projection ([#25](https://github.com/Abhijeet34/treadle/issues/25)) ([d1a9391](https://github.com/Abhijeet34/treadle/commit/d1a939177bd2c46df387ecdfac0aec4b7808bed0))
* **render:** separate scalars from tables in human rendering groups ([#23](https://github.com/Abhijeet34/treadle/issues/23)) ([fa4fb86](https://github.com/Abhijeet34/treadle/commit/fa4fb861217a7897e2a8134bfdbae3c4f7aab3cd))
* **scripts:** stop repo-settings apply from half-applying on a refused rule ([#14](https://github.com/Abhijeet34/treadle/issues/14)) ([cd8fcca](https://github.com/Abhijeet34/treadle/commit/cd8fccac143d08aad51396f0662a687e71c80f47))
* **security:** close hook contract, biased id suffix, and F11 finding ([#18](https://github.com/Abhijeet34/treadle/issues/18)) ([0fbf956](https://github.com/Abhijeet34/treadle/commit/0fbf956700d758cc459806b926ea50c1d5923d76))
* **services:** close guard-read and refusal-message gaps found in adversarial review ([#50](https://github.com/Abhijeet34/treadle/issues/50)) ([cd4e7ce](https://github.com/Abhijeet34/treadle/commit/cd4e7cef1e3cef48b6e697af367af2e07b271471))
* **sprint:** freeze a closed sprint's tally and refuse blocked or duplicate seams ([#46](https://github.com/Abhijeet34/treadle/issues/46)) ([104b6e1](https://github.com/Abhijeet34/treadle/commit/104b6e1b2a38999a7121249c8936e2968c6e932c))
* **store:** close the lock, symlink, and event-log gaps found in the second adversarial pass ([#29](https://github.com/Abhijeet34/treadle/issues/29)) ([74737d7](https://github.com/Abhijeet34/treadle/commit/74737d7e4d8d2091c026c325188b47a8eaa122b0))
* **store:** escape markdown headings in record bodies instead of refusing them ([#74](https://github.com/Abhijeet34/treadle/issues/74)) ([7655976](https://github.com/Abhijeet34/treadle/commit/7655976043a4fd78abea4e2fa178fa3d98a8b4cb))
* **store:** fence descheduled writers out of the reclaim window ([#87](https://github.com/Abhijeet34/treadle/issues/87)) ([a4a874d](https://github.com/Abhijeet34/treadle/commit/a4a874dd3b79353c6349b9e797354a89eeff20c3))
* **store:** refuse a write that leaves a record naming nothing ([#58](https://github.com/Abhijeet34/treadle/issues/58)) ([e8d35c3](https://github.com/Abhijeet34/treadle/commit/e8d35c3dbf7e7e000922257e31a6751e4b409412))
* **store:** replace the SQLite index with a plain shard read and surface unreadable-store errors ([#67](https://github.com/Abhijeet34/treadle/issues/67)) ([2668784](https://github.com/Abhijeet34/treadle/commit/266878473ec34f92728b6ec8419fce61ed083579))
* **store:** resynchronize damaged headings and resolve ids once ([#7](https://github.com/Abhijeet34/treadle/issues/7)) ([dafa913](https://github.com/Abhijeet34/treadle/commit/dafa913f6cbe227396f0134a6ce345b3afc1d1d8))
* **store:** return STORE_UNAVAILABLE instead of crashing on filesystem errors, add property/fuzz/reliability proof suite ([#6](https://github.com/Abhijeet34/treadle/issues/6)) ([c5b7c4a](https://github.com/Abhijeet34/treadle/commit/c5b7c4ac20da3c3ac1dbce4b5297134d5ec05a54))
* **store:** stop a false S14 finding from bricking a workspace ([#41](https://github.com/Abhijeet34/treadle/issues/41)) ([7660344](https://github.com/Abhijeet34/treadle/commit/7660344ec8f931e66c9f5f26b246164f209a9759))
* **store:** stop materializing full records for workspace reads ([#33](https://github.com/Abhijeet34/treadle/issues/33)) ([008824c](https://github.com/Abhijeet34/treadle/commit/008824c66b20ae880f72f1186e8679c07deb9dfd))
* **store:** validate transaction journals, bound per-holder lock waits, and escape unsafe file names ([#72](https://github.com/Abhijeet34/treadle/issues/72)) ([6e5bf60](https://github.com/Abhijeet34/treadle/commit/6e5bf60c9b0fd50554352328ccb6e429e76ca76e))
* **store:** yield between records so a bulk write keeps heartbeating ([#48](https://github.com/Abhijeet34/treadle/issues/48)) ([fab1904](https://github.com/Abhijeet34/treadle/commit/fab1904eb6a2e4f8a8677552e181004c9a9111a7))


### Performance

* **store:** close two of seven treadle budget misses, correct two, document three open ([#22](https://github.com/Abhijeet34/treadle/issues/22)) ([940316e](https://github.com/Abhijeet34/treadle/commit/940316e08524ee70cf9f2d39dd649893683fa7b7))
* **store:** stream doctor's reads and index next's ranking ([#43](https://github.com/Abhijeet34/treadle/issues/43)) ([07dc665](https://github.com/Abhijeet34/treadle/commit/07dc665756c7461062d0262496ae3679f44ea448))


### Documentation

* **adr:** decline gate and export, close threat-model finding F4 ([#90](https://github.com/Abhijeet34/treadle/issues/90)) ([4d538c6](https://github.com/Abhijeet34/treadle/commit/4d538c69ef75885d5838de53c7c1dc5d9bdbae0b))
* **adr:** move removed-feature archaeology off the first-read surface ([#71](https://github.com/Abhijeet34/treadle/issues/71)) ([f68646e](https://github.com/Abhijeet34/treadle/commit/f68646e76c0b3d91afcfadf84eaa30345c9c8ec9))
* bring documents and backlog into line with the tool as it is now, and add a drift test ([#47](https://github.com/Abhijeet34/treadle/issues/47)) ([a418b88](https://github.com/Abhijeet34/treadle/commit/a418b880108b09d43cb8b29a9cda06c199ad398c))
* correct reader-facing figures and pointers in README and ADRs ([#89](https://github.com/Abhijeet34/treadle/issues/89)) ([5e2bc0c](https://github.com/Abhijeet34/treadle/commit/5e2bc0c8e5a426af73588ef87b44b3b5626042eb))
* fix stale bundle figures, drop CLAUDE.md, enable branch cleanup ([#19](https://github.com/Abhijeet34/treadle/issues/19)) ([01580d0](https://github.com/Abhijeet34/treadle/commit/01580d05ca95a6d53626a82915400b0b22cfa569))
* re-derive stale figures and consolidate ownership across the doc set ([#81](https://github.com/Abhijeet34/treadle/issues/81)) ([31aa1ac](https://github.com/Abhijeet34/treadle/commit/31aa1acd06f2bb33cf6e36f5c8b5289cd68acfd3))


### Build and release

* **cli:** take three of four toolchain bumps, fix errno typing, hold @types/node ([#15](https://github.com/Abhijeet34/treadle/issues/15)) ([4ffae7a](https://github.com/Abhijeet34/treadle/commit/4ffae7a1d9da36163f5f7bd8b014c1bfe893ffb6))
* **release:** add release automation and supply-chain CI gates ([#8](https://github.com/Abhijeet34/treadle/issues/8)) ([01bce24](https://github.com/Abhijeet34/treadle/commit/01bce246d38ac1909bb3c6420830c7e9f157fb97))
