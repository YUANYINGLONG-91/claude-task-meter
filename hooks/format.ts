import type { Meter, Spend, Totals } from '../types'

export type Snapshot = {
  running: boolean
  elapsedMs: number
  totals: Totals
  meter: Meter
  /** 待显示的费用；custom 为按用户单价估算（画 ≈），否则是引擎账本 */
  cost: { usd: number; custom: boolean } | null
}

/** [input, output, cacheRead, cacheWrite], USD per 1M tokens */
export type Rates = readonly [number, number, number, number]
export type PriceTable = Record<string, Rates | undefined> & { default?: Rates }

/** Parses the pricing option; empty, bad JSON or no valid entry all read null */
export const parsePricing = (raw: string): PriceTable | null => {
  const s = raw.trim()
  if (!s) return null
  try {
    const v: unknown = JSON.parse(s)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    const table: Record<string, Rates> = {}
    for (const [k, r] of Object.entries(v)) {
      if (
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0)
      ) {
        table[k] = r as unknown as Rates
      }
    }
    return Object.keys(table).length > 0 ? table : null
  } catch {
    return null
  }
}

/** Per-model priced sum; null when no model hits any rate (default included) */
export const customCost = (
  byModel: Record<string, Spend>,
  table: PriceTable,
): number | null => {
  let sum = 0
  let priced = false
  for (const [model, sp] of Object.entries(byModel)) {
    const r = table[model] ?? table.default
    if (r === undefined) continue
    priced = true
    sum +=
      (sp.input * r[0] + sp.output * r[1] + sp.cacheRead * r[2] + sp.cacheWrite * r[3]) /
      1_000_000
  }
  return priced ? sum : null
}

/** 1234 → "1.2k", 2500000 → "2.5M"; below that it stays as is */
export const fmtTok = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : `${Math.round(n)}`

/** 7000 → "7s", 65000 → "1m05s", 3725000 → "1h02m" */
export const fmtDur = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}m`
}

/** Cumulative cache hit rate of the session; null before any input at all */
export const cacheHitPct = (t: Totals): number | null => {
  const inAll = t.input + t.cacheRead + t.cacheWrite
  return inAll > 0 ? Math.round((t.cacheRead / inAll) * 100) : null
}

/**
 * Extrapolated milliseconds until the context window is full, from the fill
 * rate across samples; null on too few samples or a non-positive rate, 0 when
 * already full. Compaction (tokens dropping) resets the samples upstream.
 */
export const etaToFull = (
  samples: readonly [number, number][],
  window: number,
): number | null => {
  if (window <= 0 || samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined) return null
  const [t0, tok0] = first
  const [t1, tok1] = last
  const dt = t1 - t0
  const dTok = tok1 - tok0
  if (dt < 15_000 || dTok <= 0) return null
  const remaining = window - tok1
  if (remaining <= 0) return 0
  return remaining / (dTok / dt)
}

const ETA_CAP = 4 * 3_600_000

/** Composes the one status line; segments whose figures are unknown are dropped */
export const composeLine = (s: Snapshot): string => {
  const seg: string[] = []

  seg.push(
    s.running
      ? `⚡ ${fmtDur(s.elapsedMs)} · turn ${s.totals.turns + 1}`
      : '✓ idle',
  )

  const inAll = s.totals.input + s.totals.cacheRead + s.totals.cacheWrite
  seg.push(`↑${fmtTok(inAll)} ↓${fmtTok(s.totals.output)}`)

  const hit = cacheHitPct(s.totals)
  if (hit !== null) seg.push(`cache ${hit}%`)

  if (s.meter.window > 0) {
    seg.push(
      s.meter.tokens == null
        ? `ctx —/${fmtTok(s.meter.window)}`
        : `ctx ${s.meter.percent ?? Math.round((s.meter.tokens / s.meter.window) * 100)}% · ${fmtTok(s.meter.tokens)}/${fmtTok(s.meter.window)}`,
    )
  }

  const eta = etaToFull(s.meter.samples, s.meter.window)
  if (eta !== null) {
    seg.push(
      eta === 0 ? 'context full' : eta > ETA_CAP ? '>4h to full' : `≈${fmtDur(eta)} to full`,
    )
  }

  if (s.cost !== null) {
    seg.push(`${s.cost.custom ? '≈' : ''}$${s.cost.usd.toFixed(2)}`)
  }

  return seg.join(' │ ')
}
