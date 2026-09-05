// SPDX-License-Identifier: Apache-2.0
// Generators and a disposable workspace for the store suites. The generators are seeded so
// a failing case is reproducible from the seed printed in the assertion, which is what makes
// a property test a debuggable one rather than a lottery.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  BUG_SEVERITIES,
  DEFAULT_POINT_SCALE,
  FOUND_IN_STAGES,
  WORK_ITEM_TYPES,
  type AcceptanceCriterion,
  type WorkItem,
  type WorkItemType,
} from '../../src/domain/index.ts'
import { createWorkspace, type ShardedStoreOptions } from '../../src/adapters/store/index.ts'
import { ShardedStore } from '../../src/adapters/store/index.ts'
import type { StoreEvent } from '../../src/application/ports/store.ts'

/** mulberry32: 32 bits of state, uniform enough for fixtures and exactly reproducible. */
export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A family emoji, whose two U+200D joiners the safe-text class allows only between two
 * pictographs. Built from its code points rather than written as a literal: no invisible
 * character is a literal anywhere in this repository, because one is unreadable in a diff
 * and indistinguishable from a hidden marker. `test/architecture/invisible.test.ts` enforces it.
 */
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)

export class Gen {
  readonly #next: () => number

  constructor(seed: number) {
    this.#next = random(seed)
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.#next() * (max - min + 1))
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T
  }

  chance(p: number): boolean {
    return this.#next() < p
  }

  slug(min = 3, max = 24): string {
    const head = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const body = `${head}-`
    const length = this.int(min, max)
    let out = this.pick([...head])
    for (let i = 1; i < length - 1; i += 1) out += this.pick([...body])
    return out + this.pick([...head])
  }

  /**
   * Characters that must survive a round trip untouched, including a family emoji whose
   * U+200D joiner the safe-text class allows only between two pictographs.
   */
  safeLine(min = 1, max = 60): string {
    const alphabet = [
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      ...' .,;:!?()[]{}<>/\\|@#$%^&*-_=+"\'`~',
      'é', 'ü', 'ß', 'ñ', 'ø', 'ç', 'æ', 'Ω', 'π', 'д', 'ж', '中', '文', '日', '本',
      '🙂', '🚀', FAMILY, 'حرف', 'עברית',
    ]
    for (;;) {
      const length = this.int(min, max)
      let out = ''
      for (let i = 0; i < length; i += 1) out += this.pick(alphabet)
      const trimmed = out.trim()
      if (trimmed.length > 0) return trimmed
    }
  }

  /** A body with no line starting with `#`, which DR3 rule 1 refuses to write. */
  safeBody(maxLines = 5): string {
    const lines: string[] = []
    for (let i = 0; i < this.int(1, maxLines); i += 1) {
      lines.push(this.chance(0.15) ? '' : this.safeLine(1, 70).replace(/^#+/, 'x'))
    }
    while (lines.length > 0 && lines[0] === '') lines.shift()
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.length === 0 ? this.safeLine(1, 20) : lines.join('\n')
  }

  instant(): string {
    const year = this.int(2024, 2027)
    const month = String(this.int(1, 12)).padStart(2, '0')
    const day = String(this.int(1, 28)).padStart(2, '0')
    const hour = String(this.int(0, 23)).padStart(2, '0')
    const minute = String(this.int(0, 59)).padStart(2, '0')
    const second = String(this.int(0, 59)).padStart(2, '0')
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
  }

  criteria(): readonly AcceptanceCriterion[] {
    const out: AcceptanceCriterion[] = []
    for (let i = 0; i < this.int(1, 4); i += 1) {
      out.push({ text: this.safeLine(1, 60), ticked: this.chance(0.5) })
    }
    return out
  }

  workItem(overrides: Partial<WorkItem> = {}): WorkItem {
    const type: WorkItemType = overrides.type ?? this.pick(WORK_ITEM_TYPES)
    const base: Record<string, unknown> = {
      id: this.slug(),
      type,
      state: 'draft',
      title: this.safeLine(1, 80),
      filed_at: this.instant(),
      version: 1,
    }
    if (this.chance(0.6)) base['description'] = this.safeBody()
    if (this.chance(0.5)) base['priority'] = this.int(1, 5)
    if (this.chance(0.5)) base['points'] = this.pick(DEFAULT_POINT_SCALE)
    if (this.chance(0.3)) base['hours_estimate'] = this.int(1, 400)
    if (this.chance(0.4)) base['assignee'] = this.safeLine(1, 30)
    if (this.chance(0.3)) base['reporter'] = this.safeLine(1, 30)
    if (this.chance(0.3)) base['component'] = this.safeLine(1, 30)
    if (this.chance(0.4)) base['sprint_id'] = this.slug()
    if (this.chance(0.4)) {
      const labels = new Set<string>()
      for (let i = 0; i < this.int(1, 3); i += 1) labels.add(this.slug())
      base['labels'] = [...labels]
    }
    if (type === 'epic') {
      base['outcome'] = this.safeBody()
      if (this.chance(0.5)) base['target_date'] = this.instant()
    }
    if (type === 'story' && this.chance(0.7)) base['acceptance_criteria'] = this.criteria()
    if (type === 'bug') {
      base['severity'] = this.pick(BUG_SEVERITIES)
      base['repro_steps'] = this.safeBody()
      base['found_in'] = this.pick(FOUND_IN_STAGES)
      if (this.chance(0.6)) base['expected'] = this.safeBody()
      if (this.chance(0.6)) base['actual'] = this.safeBody()
      if (this.chance(0.4)) base['fix_confirmed'] = this.chance(0.5)
    }
    if (type === 'spike') {
      base['question'] = this.safeBody()
      base['timebox_hours'] = this.int(1, 80)
      if (this.chance(0.5)) base['findings'] = this.safeBody()
    }
    return { ...(base as unknown as WorkItem), ...overrides }
  }
}

export function anItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item-one',
    type: 'task',
    state: 'draft',
    title: 'A first task',
    filed_at: '2026-09-01T10:00:00Z',
    version: 1,
    ...overrides,
  }
}

export function anEvent(overrides: Partial<StoreEvent> = {}): StoreEvent {
  return {
    id: 'ev-1',
    at: '2026-09-01T10:00:00Z',
    actor: 'abhijeet',
    actor_kind: 'person',
    entity_kind: 'work_item',
    entity: 'item-one',
    op: 'file',
    txn: 'txn-1',
    ...overrides,
  }
}

export type Workspace = {
  readonly root: string
  readonly store: ShardedStore
  dispose(): Promise<void>
}

export async function aWorkspace(options: ShardedStoreOptions = {}): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadle-store-'))
  const made = await createWorkspace(root, {
    id: 'test-workspace',
    name: 'Test workspace',
    at: '2026-09-01T09:00:00Z',
  })
  if (!made.ok) throw new Error(made.error.message)
  const store = new ShardedStore(root, options)
  return {
    root,
    store,
    async dispose(): Promise<void> {
      await store.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
