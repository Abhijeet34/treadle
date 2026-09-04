// SPDX-License-Identifier: Apache-2.0
// Verbose diagnostics, and finding F10.
//
// `-vvv` logs the raw store operations, and a record's fields are free text that somebody
// may have pasted a credential into. stderr is captured by CI jobs and agent transcripts,
// so a value logged there outlives the run that logged it. Every field value is therefore
// reported as its name and its size, and `--log-values` is the explicit opt-in that says
// the caller accepts the disclosure.

export type Level = 0 | 1 | 2 | 3

export type DiagnosticsOptions = {
  readonly level: Level
  readonly logValues: boolean
  readonly write: (line: string) => void
}

/** A value reported by name and size, never by content, unless the caller opted in. */
export function redact(value: unknown, logValues: boolean): string {
  if (value === undefined || value === null) return '-'
  if (logValues) return String(value).replace(/\n/g, '\\n')
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return `<redacted ${Buffer.byteLength(text, 'utf8')}B>`
}

export class Diagnostics {
  readonly #options: DiagnosticsOptions

  constructor(options: DiagnosticsOptions) {
    this.#options = options
  }

  get level(): Level {
    return this.#options.level
  }

  /** One resolved fact a caller asked for with `-v`: a path, a source, a guard verdict. */
  note(key: string, value: string): void {
    if (this.#options.level >= 1) this.#options.write(`v ${key} ${value}`)
  }

  timing(phase: string, ms: number): void {
    if (this.#options.level >= 2) this.#options.write(`vv ${phase} ${ms}ms`)
  }

  /** One raw store operation. Field values are named and sized rather than printed (F10). */
  store(operation: string, fields: Readonly<Record<string, unknown>>): void {
    if (this.#options.level < 3) return
    const parts = Object.entries(fields)
      .map(([name, value]) => `${name}=${redact(value, this.#options.logValues)}`)
    this.#options.write(`vvv store ${operation} ${parts.join(' ')}`)
  }
}
