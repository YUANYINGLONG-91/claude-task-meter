import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Spend } from '../types'
import {
  composeLine,
  customCost,
  METER0,
  parsePricing,
  parseSaved,
  TOTALS0,
  type PriceTable,
} from './format'

/** Fill-rate sampling cap, and the token drop that reads as a compaction */
const MAX_SAMPLES = 12
const SHRINK_RESET = 1024
/** Conversations idle longer than this get their stored blob pruned */
const STALE_MS = 30 * 24 * 3_600_000

// A hot reload re-runs the module, resetting these; the durable copy is the
// $.store blob under the conversation's session id
let convKey = ''
let curTotals = TOTALS0
let curMeter = METER0
let turnStartedAt = 0
let tick: Timer | null = null
let priceTable: PriceTable | null = null
let showCost = true
/** The session's model as /config holds it; the last turn's usage is the fallback */
let currentModel: string | null = null

/**
 * Adopts the store blob of the session we're in. No-op while the id is what
 * we already hold; a /clear swaps the session id without a session.start, and
 * a resume comes back under the same id — both are caught here.
 */
const adopt = async ($: EngineInterface) => {
  const id = await $.session.id()
  if (id === convKey) return
  convKey = id
  const saved = parseSaved(await $.store.get(id))
  curTotals = saved?.totals ?? TOTALS0
  curMeter = saved?.meter ?? METER0
}

const persist = async ($: EngineInterface) => {
  if (!convKey) return
  await $.store.set(convKey, {
    v: 1,
    updatedAt: await $.clock.now(),
    totals: curTotals,
    meter: curMeter,
  })
}

/** Drops blobs of conversations idle past STALE_MS, keeping the file small */
const prune = async ($: EngineInterface) => {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    const saved = parseSaved(await $.store.get(key))
    if (saved !== null && saved.updatedAt > 0 && now - saved.updatedAt > STALE_MS) {
      await $.store.delete(key)
    }
  }
}

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

  // Custom rates price per model (drawn with ≈); otherwise the engine's
  // ledger (the /cost figure) stands
  let cost: { usd: number; custom: boolean } | null = null
  if (showCost) {
    const custom = priceTable === null ? null : customCost(curTotals.byModel, priceTable)
    if (custom !== null) cost = { usd: custom, custom: true }
    else if (curMeter.usd != null) cost = { usd: curMeter.usd, custom: false }
  }

  $.ui.status(
    composeLine({
      running: turnStartedAt > 0,
      elapsedMs: turnStartedAt > 0 ? now - turnStartedAt : 0,
      model: currentModel ?? curTotals.lastModel,
      totals: curTotals,
      meter: curMeter,
      cost,
    }),
  )
}

export const register: Register = (on, options) => {
  priceTable = parsePricing(typeof options.pricing === 'string' ? options.pricing : '')
  showCost = options.showCost !== false

  on('session.start', async ($, e, next) => {
    await adopt($)
    await prune($)
    await refreshModel($)
    await render($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await adopt($)
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

    const u = e.usage
    const byModel: Record<string, Spend> = { ...curTotals.byModel }
    if (u !== undefined) {
      const prev = byModel[u.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      byModel[u.model] = {
        input: prev.input + u.input_tokens,
        output: prev.output + u.output_tokens,
        cacheRead: prev.cacheRead + u.cache_read_input_tokens,
        cacheWrite: prev.cacheWrite + u.cache_creation_input_tokens,
      }
    }
    curTotals = {
      input: curTotals.input + (u?.input_tokens ?? 0),
      output: curTotals.output + (u?.output_tokens ?? 0),
      cacheRead: curTotals.cacheRead + (u?.cache_read_input_tokens ?? 0),
      cacheWrite: curTotals.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
      turns: curTotals.turns + 1,
      turnMs: curTotals.turnMs + e.durationMs,
      byModel,
      lastModel: u?.model ?? curTotals.lastModel,
    }
    await persist($)
    await render($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()

    // Before the live window's first response the last reading stands; a
    // sharp token drop is a compaction, and the rate sampling starts over
    const tokens = e.context.tokens ?? curMeter.tokens
    let samples = curMeter.samples
    if (tokens != null) {
      const last = samples[samples.length - 1]
      samples = (
        last !== undefined && tokens < last[1] - SHRINK_RESET
          ? [[now, tokens] as [number, number]]
          : [...samples, [now, tokens] as [number, number]]
      ).slice(-MAX_SAMPLES)
    }

    curMeter = {
      tokens,
      window: e.context.window,
      percent: e.context.percent ?? curMeter.percent,
      usd: e.cost?.usd ?? curMeter.usd,
      samples,
    }
    await persist($)
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
}
