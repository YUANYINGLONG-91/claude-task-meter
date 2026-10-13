import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Meter, Spend, Totals } from '../types'
import { composeLine, customCost, parsePricing, type PriceTable } from './format'

const totalsRef = { plugin: 'task-meter', key: 'totals' } as const
const meterRef = { plugin: 'task-meter', key: 'meter' } as const

const TOTALS0: Totals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  turnMs: 0,
  byModel: {},
  lastModel: null,
}
const METER0: Meter = {
  tokens: null,
  window: 0,
  percent: null,
  usd: null,
  samples: [],
}

/** Fill-rate sampling cap, and the token drop that reads as a compaction */
const MAX_SAMPLES = 12
const SHRINK_RESET = 1024

// A hot reload re-runs the module, resetting these; what persists is in $.state
let turnStartedAt = 0
let tick: Timer | null = null
let priceTable: PriceTable | null = null
let showCost = true
/** The session's model as /config holds it; the last turn's usage is the fallback */
let currentModel: string | null = null

const refreshModel = async ($: EngineInterface) => {
  // A config read that fails must never hold up the line; the last turn's
  // model (usage.model) remains as the fallback
  try {
    const rows = await $.config.list()
    const row = rows.find(r => r.key === 'model') ?? rows.find(r => /model/i.test(r.key))
    currentModel = typeof row?.value === 'string' ? row.value : null
  } catch {
    currentModel = null
  }
}

const render = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const [{ value: totals }, { value: meter }] = await Promise.all([
    $.state.get(totalsRef),
    $.state.get(meterRef),
  ])
  const t = totals ?? TOTALS0
  const m = meter ?? METER0

  // Custom rates price per model (drawn with ≈); otherwise the engine's
  // ledger (the /cost figure) stands
  let cost: { usd: number; custom: boolean } | null = null
  if (showCost) {
    const custom = priceTable === null ? null : customCost(t.byModel ?? {}, priceTable)
    if (custom !== null) cost = { usd: custom, custom: true }
    else if (m.usd != null) cost = { usd: m.usd, custom: false }
  }

  $.ui.status(
    composeLine({
      running: turnStartedAt > 0,
      elapsedMs: turnStartedAt > 0 ? now - turnStartedAt : 0,
      model: currentModel ?? t.lastModel ?? null,
      totals: t,
      meter: m,
      cost,
    }),
  )
}

export const register: Register = (on, options) => {
  priceTable = parsePricing(typeof options.pricing === 'string' ? options.pricing : '')
  showCost = options.showCost !== false

  on('session.start', async ($, e, next) => {
    await refreshModel($)
    await render($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnStartedAt = await $.clock.now()
    tick?.cancel()
    tick = $.clock.every(1000, () => {
      void render($)
    })
    await refreshModel($)
    await render($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    tick?.cancel()
    tick = null
    turnStartedAt = 0

    const { value: t = TOTALS0 } = await $.state.get(totalsRef)
    const u = e.usage

    const byModel: Record<string, Spend> = { ...(t.byModel ?? {}) }
    if (u !== undefined) {
      const prev = byModel[u.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      byModel[u.model] = {
        input: prev.input + u.input_tokens,
        output: prev.output + u.output_tokens,
        cacheRead: prev.cacheRead + u.cache_read_input_tokens,
        cacheWrite: prev.cacheWrite + u.cache_creation_input_tokens,
      }
    }

    await $.state.set(totalsRef, {
      input: t.input + (u?.input_tokens ?? 0),
      output: t.output + (u?.output_tokens ?? 0),
      cacheRead: t.cacheRead + (u?.cache_read_input_tokens ?? 0),
      cacheWrite: t.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
      turns: t.turns + 1,
      turnMs: t.turnMs + e.durationMs,
      byModel,
      lastModel: u?.model ?? t.lastModel ?? null,
    })
    await render($)
    return next(e)
  })

  // A model switch in /config refreshes the line at once, mid-idle too
  on('config.set', async ($, e, next) => {
    const result = await next(e)
    if (/model/i.test(e.key)) {
      await refreshModel($)
      await render($)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const { value: m = METER0 } = await $.state.get(meterRef)

    // Before the live window's first response the last reading stands; a
    // sharp token drop is a compaction, and the rate sampling starts over
    const tokens = e.context.tokens ?? m.tokens
    let samples = m.samples
    if (tokens != null) {
      const last = samples[samples.length - 1]
      samples = (
        last !== undefined && tokens < last[1] - SHRINK_RESET
          ? [[now, tokens] as [number, number]]
          : [...samples, [now, tokens] as [number, number]]
      ).slice(-MAX_SAMPLES)
    }

    await $.state.set(meterRef, {
      tokens,
      window: e.context.window,
      percent: e.context.percent ?? m.percent,
      usd: e.cost?.usd ?? m.usd,
      samples,
    })
    await render($)
    return next(e)
  })
}
