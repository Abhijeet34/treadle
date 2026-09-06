# Changelog

## 0.1.0 (2026-09-06)


### ⚠ BREAKING CHANGES

* **status:** the status result object no longer declares absent_features, and its schema id is status/2.
* **sprint:** `file --sprint <id>` now refuses an id that names no open sprint and an item that cannot enter one (I2, I4); it stored any string before. `set <id> sprint_id=` is refused in favour of `treadle sprint commit`.
* **store:** close the lock, symlink, and event-log gaps found in the second adversarial pass ([#29](https://github.com/Abhijeet34/treadle/issues/29))
* **cli:** a command run against a store that holds a record it cannot serve exits 7 where it exited 0 with the record missing from its count, `doctor` exits 7 with findings where it exited 0, and a domain integrity error exits 7 where it exited 6. Nothing is released; these are release notes under docs/STABILITY.md rather than a bump.
* **cli:** with no command word, any global flag the tool cannot honour is now refused instead of being silently dropped. On d1a9391 `treadle --out` (a value missing) and `treadle --quiet=1` (a value on a boolean) both exited 0 and ran the default `status` command with the flag dropped or misparsed; both now exit 2, with `--out needs a value` and `--quiet takes no value`. `treadle --nope` exits 2 with `--nope is not a flag of treadle`. docs/STABILITY.md calls a new non-zero exit for a case that used to succeed breaking, and release-please-config.json sets `bump-minor-pre-major: true`, so this bumps the minor.

### Features

* **board:** add board as a projection of the backlog by state ([#37](https://github.com/Abhijeet34/treadle/issues/37)) ([4b2875d](https://github.com/Abhijeet34/treadle/commit/4b2875dcd30c5b081170bdc35271129ff3b59f02))
* **cli:** add set command and unify the description/desc field name ([#24](https://github.com/Abhijeet34/treadle/issues/24)) ([02251fa](https://github.com/Abhijeet34/treadle/commit/02251facd167ad45d25d730aa0c53e395205ce38))
* **cli:** add treadle's runnable command surface with output contract and renderers ([#3](https://github.com/Abhijeet34/treadle/issues/3)) ([7da36b0](https://github.com/Abhijeet34/treadle/commit/7da36b0817e5e23b7e8f2bd76cadb03b6a81f2e3))
* **cli:** audit severity/priority changes and bound evidence with doctor checks ([#13](https://github.com/Abhijeet34/treadle/issues/13)) ([3614049](https://github.com/Abhijeet34/treadle/commit/3614049f4f23d5b54cf4aff4eff2ab02822cdf76))
* **cli:** surface actor history and sweep hidden persisted fields ([#21](https://github.com/Abhijeet34/treadle/issues/21)) ([7ca95a0](https://github.com/Abhijeet34/treadle/commit/7ca95a0c9db38da871f1dfcb67f9e076b57c976f))
* **domain:** add cancel resolutions, release outcomes, due dates and reviewability markers ([#11](https://github.com/Abhijeet34/treadle/issues/11)) ([d965cb8](https://github.com/Abhijeet34/treadle/commit/d965cb8b3e428164f09bb52c2928d87f80121faf))
* **impediment:** add a blocker type that must say what would clear it ([#36](https://github.com/Abhijeet34/treadle/issues/36)) ([cc3fc6d](https://github.com/Abhijeet34/treadle/commit/cc3fc6dc8777a9c0f8f72dfd8c6bac1747c15adb))
* **relation:** add typed links between items with guards, doctor findings, and derived reads ([#34](https://github.com/Abhijeet34/treadle/issues/34)) ([8d8d33d](https://github.com/Abhijeet34/treadle/commit/8d8d33dfd63642c721fa56d619e2776d10080f35))
* **sprint:** add sprint lifecycle with commit tracking and carry-over ([#35](https://github.com/Abhijeet34/treadle/issues/35)) ([fbab9fb](https://github.com/Abhijeet34/treadle/commit/fbab9fb1b602900f0bf791521d5208157afe2beb))
* **status:** drop absent_features and guard against a re-added harness instruction file ([#39](https://github.com/Abhijeet34/treadle/issues/39)) ([9888781](https://github.com/Abhijeet34/treadle/commit/9888781983089880002802aee5e4334206aba5ea))
* **store:** add sharded record store with durability and overlay seam ([#2](https://github.com/Abhijeet34/treadle/issues/2)) ([c4fb9a1](https://github.com/Abhijeet34/treadle/commit/c4fb9a1e108862eb5f5e53c2dfebac872f92e898))


### Bug Fixes

* **application:** fix criteria readback and history echo defects ([#28](https://github.com/Abhijeet34/treadle/issues/28)) ([6a8f012](https://github.com/Abhijeet34/treadle/commit/6a8f0125fa424a02caef75bbf2e6035d672fbcfd))
* **bench:** fix pagination, doctor scale, and extensibility defects found by stress benchmarking ([#30](https://github.com/Abhijeet34/treadle/issues/30)) ([3bce1ca](https://github.com/Abhijeet34/treadle/commit/3bce1ca400b6b6bb1989b29f3ad8242415f69280))
* **cli:** close four live interface defects in history, backlog, and parsing ([#26](https://github.com/Abhijeet34/treadle/issues/26)) ([0286e42](https://github.com/Abhijeet34/treadle/commit/0286e42eea2233c2f768b5bba966ddd16672cb86))
* **cli:** honor --out json for refusals raised before flag parsing ([#40](https://github.com/Abhijeet34/treadle/issues/40)) ([f8e5a4c](https://github.com/Abhijeet34/treadle/commit/f8e5a4cc16bb3465e6bd6e6265e02e1af7f52b43))
* **cli:** make transition guards, effects and flags match what treadle tells callers ([#45](https://github.com/Abhijeet34/treadle/issues/45)) ([9c5fc59](https://github.com/Abhijeet34/treadle/commit/9c5fc59d7534391ea68997ead7ed95e85ab00f51))
* **cli:** refuse reads over corrupt records and hold the width contract ([#27](https://github.com/Abhijeet34/treadle/issues/27)) ([5a78152](https://github.com/Abhijeet34/treadle/commit/5a78152be75f2a152127529b79b8b8dcfd949881))
* close eight defects found by driving treadle's command surface ([#4](https://github.com/Abhijeet34/treadle/issues/4)) ([d5dd734](https://github.com/Abhijeet34/treadle/commit/d5dd734e337aef385230aac1ec4ce308d334d8b4))
* **hierarchy:** guard parent writes and clear fields by empty value ([#44](https://github.com/Abhijeet34/treadle/issues/44)) ([5444209](https://github.com/Abhijeet34/treadle/commit/5444209424539a61f60f2e945ee4e749923c81d6))
* **relation:** guard concurrent cycle writes and close adjacent validation gaps ([#38](https://github.com/Abhijeet34/treadle/issues/38)) ([40c3f30](https://github.com/Abhijeet34/treadle/commit/40c3f30853d44d2017526d45fcd2b38488be719f))
* **remedy:** make every printed page, cursor and remedy line runnable as printed ([#42](https://github.com/Abhijeet34/treadle/issues/42)) ([1879286](https://github.com/Abhijeet34/treadle/commit/187928658005529379f41d4af13537374f60ceb0))
* **render:** move root-level scalars ahead of blocks in every command's projection ([#25](https://github.com/Abhijeet34/treadle/issues/25)) ([d1a9391](https://github.com/Abhijeet34/treadle/commit/d1a939177bd2c46df387ecdfac0aec4b7808bed0))
* **render:** separate scalars from tables in human rendering groups ([#23](https://github.com/Abhijeet34/treadle/issues/23)) ([fa4fb86](https://github.com/Abhijeet34/treadle/commit/fa4fb861217a7897e2a8134bfdbae3c4f7aab3cd))
* **scripts:** stop repo-settings apply from half-applying on a refused rule ([#14](https://github.com/Abhijeet34/treadle/issues/14)) ([cd8fcca](https://github.com/Abhijeet34/treadle/commit/cd8fccac143d08aad51396f0662a687e71c80f47))
* **security:** close hook contract, biased id suffix, and F11 finding ([#18](https://github.com/Abhijeet34/treadle/issues/18)) ([0fbf956](https://github.com/Abhijeet34/treadle/commit/0fbf956700d758cc459806b926ea50c1d5923d76))
* **sprint:** freeze a closed sprint's tally and refuse blocked or duplicate seams ([#46](https://github.com/Abhijeet34/treadle/issues/46)) ([104b6e1](https://github.com/Abhijeet34/treadle/commit/104b6e1b2a38999a7121249c8936e2968c6e932c))
* **store:** close the lock, symlink, and event-log gaps found in the second adversarial pass ([#29](https://github.com/Abhijeet34/treadle/issues/29)) ([74737d7](https://github.com/Abhijeet34/treadle/commit/74737d7e4d8d2091c026c325188b47a8eaa122b0))
* **store:** resynchronize damaged headings and resolve ids once ([#7](https://github.com/Abhijeet34/treadle/issues/7)) ([dafa913](https://github.com/Abhijeet34/treadle/commit/dafa913f6cbe227396f0134a6ce345b3afc1d1d8))
* **store:** return STORE_UNAVAILABLE instead of crashing on filesystem errors, add property/fuzz/reliability proof suite ([#6](https://github.com/Abhijeet34/treadle/issues/6)) ([c5b7c4a](https://github.com/Abhijeet34/treadle/commit/c5b7c4ac20da3c3ac1dbce4b5297134d5ec05a54))
* **store:** stop a false S14 finding from bricking a workspace ([#41](https://github.com/Abhijeet34/treadle/issues/41)) ([7660344](https://github.com/Abhijeet34/treadle/commit/7660344ec8f931e66c9f5f26b246164f209a9759))
* **store:** stop materializing full records for workspace reads ([#33](https://github.com/Abhijeet34/treadle/issues/33)) ([008824c](https://github.com/Abhijeet34/treadle/commit/008824c66b20ae880f72f1186e8679c07deb9dfd))
* **store:** yield between records so a bulk write keeps heartbeating ([#48](https://github.com/Abhijeet34/treadle/issues/48)) ([fab1904](https://github.com/Abhijeet34/treadle/commit/fab1904eb6a2e4f8a8677552e181004c9a9111a7))


### Performance

* **store:** close two of seven treadle budget misses, correct two, document three open ([#22](https://github.com/Abhijeet34/treadle/issues/22)) ([940316e](https://github.com/Abhijeet34/treadle/commit/940316e08524ee70cf9f2d39dd649893683fa7b7))
* **store:** stream doctor's reads and index next's ranking ([#43](https://github.com/Abhijeet34/treadle/issues/43)) ([07dc665](https://github.com/Abhijeet34/treadle/commit/07dc665756c7461062d0262496ae3679f44ea448))


### Documentation

* bring documents and backlog into line with the tool as it is now, and add a drift test ([#47](https://github.com/Abhijeet34/treadle/issues/47)) ([a418b88](https://github.com/Abhijeet34/treadle/commit/a418b880108b09d43cb8b29a9cda06c199ad398c))
* fix stale bundle figures, drop CLAUDE.md, enable branch cleanup ([#19](https://github.com/Abhijeet34/treadle/issues/19)) ([01580d0](https://github.com/Abhijeet34/treadle/commit/01580d05ca95a6d53626a82915400b0b22cfa569))


### Build and release

* **cli:** take three of four toolchain bumps, fix errno typing, hold @types/node ([#15](https://github.com/Abhijeet34/treadle/issues/15)) ([4ffae7a](https://github.com/Abhijeet34/treadle/commit/4ffae7a1d9da36163f5f7bd8b014c1bfe893ffb6))
* **release:** add release automation and supply-chain CI gates ([#8](https://github.com/Abhijeet34/treadle/issues/8)) ([01bce24](https://github.com/Abhijeet34/treadle/commit/01bce246d38ac1909bb3c6420830c7e9f157fb97))
