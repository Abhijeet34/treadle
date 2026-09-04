// SPDX-License-Identifier: Apache-2.0
// A separate process that holds the derived index in the one state the WAL switch has to
// wait for: present, still in the default journal mode, and write-locked by somebody else.
//
// That is the window a fresh index passes through. The first process to arrive creates
// index.sqlite in delete mode and only then switches it to WAL, and a second process that
// opens the file inside that window meets exactly this. Holding it open for a stated number
// of milliseconds is what turns a race into an assertion.
//
// Usage: index-holder.ts <path to index.sqlite> <hold ms>

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [file, holdMs] = process.argv.slice(2)

mkdirSync(path.dirname(file as string), { recursive: true })
const db = new DatabaseSync(file as string)
db.exec('create table if not exists holder (a integer)')
db.exec('begin exclusive')
db.prepare('insert into holder values (?)').run(1)
process.stdout.write('held\n')
await delay(Number(holdMs))
db.exec('commit')
db.close()
