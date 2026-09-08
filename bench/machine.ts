// SPDX-License-Identifier: Apache-2.0
// The facts that make a figure meaningful. DR1's method names the machine and the runtime
// beside every number, because a millisecond is not portable; this collects them once so
// every emitted row can carry them.

import { cpus, totalmem, arch, platform, release } from 'node:os'

export type Machine = {
  readonly platform: string
  readonly release: string
  readonly arch: string
  readonly cpuModel: string
  readonly cores: number
  readonly memoryBytes: number
  readonly node: string
  readonly v8: string
  /** The floor this package declares. It is stated because this machine may be under it. */
  readonly declaredNodeFloor: string
  readonly nodeMeetsFloor: boolean
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
    declaredNodeFloor,
    nodeMeetsFloor: meetsFloor(process.versions.node, declaredNodeFloor),
  }
}
