// SPDX-License-Identifier: Apache-2.0
// The facts that make a figure meaningful. DR1's method names the machine and the runtime
// beside every number, because a millisecond is not portable; this collects them once so
// every emitted row can carry them.

import { cpus, totalmem, arch, platform, release } from 'node:os'
import { execFileSync } from 'node:child_process'

export type Machine = {
  readonly platform: string
  readonly release: string
  readonly arch: string
  readonly cpuModel: string
  readonly cores: number
  readonly memoryBytes: number
  readonly node: string
  readonly v8: string
  readonly sqlite: string
  /** The floor this package declares. It is stated because this machine may be under it. */
  readonly declaredNodeFloor: string
  readonly nodeMeetsFloor: boolean
}

function sqliteVersion(): string {
  try {
    // `node:sqlite` is the index engine (DR2); its version is part of what a read costs.
    const out = execFileSync(process.execPath, [
      '-e',
      'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(":memory:");' +
      'process.stdout.write(String(d.prepare("select sqlite_version() as v").get().v))',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim()
  } catch (error) {
    return `NOT MEASURED: ${(error as Error).message}`
  }
}

function meetsFloor(actual: string, floor: string): boolean {
  const a = actual.split('.').map(Number)
  const f = floor.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = f[i] ?? 0
    if (left !== right) return left > right
  }
  return true
}

export function describeMachine(declaredNodeFloor: string): Machine {
  const list = cpus()
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: list[0]?.model ?? 'NOT MEASURED: os.cpus() returned no entry',
    cores: list.length,
    memoryBytes: totalmem(),
    node: process.versions.node,
    v8: process.versions.v8,
    sqlite: sqliteVersion(),
    declaredNodeFloor,
    nodeMeetsFloor: meetsFloor(process.versions.node, declaredNodeFloor),
  }
}
