import { expect, test } from 'claude-code/testing'

import {
  cacheHitPct,
  composeLine,
  customCost,
  etaToFull,
  fmtDur,
  fmtModel,
  fmtTok,
  parsePricing,
  parseSaved,
} from './format'

const T0 = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  turnMs: 0,
  byModel: {},
  lastModel: null,
}

test('fmtTok abbreviates by magnitude', () => {
  expect(fmtTok(0)).toBe('0')
  expect(fmtTok(999)).toBe('999')
  expect(fmtTok(1500)).toBe('1.5k')
  expect(fmtTok(2_500_000)).toBe('2.5M')
})

test('fmtDur carries into minutes and hours', () => {
  expect(fmtDur(7_000)).toBe('7s')
  expect(fmtDur(65_000)).toBe('1m05s')
  expect(fmtDur(3_725_000)).toBe('1h02m')
})

test('fmtModel strips the claude- prefix and a date suffix', () => {
  expect(fmtModel('claude-opus-4-7')).toBe('opus-4-7')
  expect(fmtModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
  expect(fmtModel('some-relay-model')).toBe('some-relay-model')
})

test('cacheHitPct is null before any input', () => {
  expect(cacheHitPct(T0)).toBe(null)
  expect(cacheHitPct({ ...T0, input: 5, cacheRead: 90, cacheWrite: 5 })).toBe(90)
})

test('etaToFull needs enough samples and a positive rate', () => {
  expect(etaToFull([], 200_000)).toBe(null)
  expect(etaToFull([[0, 1000], [10_000, 2000]], 200_000)).toBe(null)
  // 0 → 60k over 60s is 1k/s; 140k remaining makes 140s
  expect(etaToFull([[0, 0], [60_000, 60_000]], 200_000)).toBe(140_000)
  expect(etaToFull([[0, 190_000], [60_000, 200_000]], 200_000)).toBe(0)
})

test('parsePricing tolerates empty input and bad JSON', () => {
  expect(parsePricing('')).toBe(null)
  expect(parsePricing('  ')).toBe(null)
  expect(parsePricing('not json')).toBe(null)
  expect(parsePricing('[1,2,3,4]')).toBe(null)
  expect(parsePricing('{"a":[1,2]}')).toBe(null)
})

test('parsePricing drops bad entries and keeps good ones', () => {
  const t = parsePricing('{"default":[3,15,0.3,3.75],"bad":[1,2],"neg":[1,2,3,-4]}')
  expect(t?.default).toEqual([3, 15, 0.3, 3.75])
  expect(t?.bad).toBeUndefined()
  expect(t?.neg).toBeUndefined()
})

test('customCost prices each model at its own rates, default as fallback', () => {
  const byModel = {
    'relay-opus': { input: 1_000_000, output: 100_000, cacheRead: 10_000_000, cacheWrite: 0 },
    other: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
  }
  // relay-opus: 1M×15 + 0.1M×75 + 10M×1.5 = 15 + 7.5 + 15 = 37.5
  // other at default: 1M×15 = 15; together 52.5
  const cost = customCost(byModel, {
    'relay-opus': [15, 75, 1.5, 18.75],
    default: [3, 15, 0.3, 3.75],
  })
  expect(cost).toBe(52.5)
})

test('customCost is null when nothing matches a rate', () => {
  const byModel = { x: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }
  expect(customCost(byModel, { 'claude-opus-4-7': [15, 75, 1.5, 18.75] })).toBe(null)
  expect(customCost({}, { default: [3, 15, 0.3, 3.75] })).toBe(null)
})

test('parseSaved reads back a blob and drops its rate samples', () => {
  const blob = {
    v: 1,
    updatedAt: 123,
    totals: { ...T0, input: 500, turns: 4, lastModel: 'claude-opus-4-7' },
    meter: { tokens: 90_000, window: 200_000, percent: 45, usd: 0.4, samples: [[1, 2]] },
  }
  const s = parseSaved(blob)
  expect(s?.totals.input).toBe(500)
  expect(s?.totals.turns).toBe(4)
  expect(s?.totals.lastModel).toBe('claude-opus-4-7')
  expect(s?.meter.tokens).toBe(90_000)
  expect(s?.meter.samples).toEqual([])
})

test('parseSaved rejects junk and fills defaults for older blobs', () => {
  expect(parseSaved(undefined)).toBe(null)
  expect(parseSaved('x')).toBe(null)
  expect(parseSaved({ totals: 'no', meter: {} })).toBe(null)
  // a 0.2-era blob: no byModel, no lastModel
  const old = {
    totals: { input: 5, output: 1, cacheRead: 2, cacheWrite: 3, turns: 1, turnMs: 9 },
    meter: { tokens: 10, window: 200_000, percent: 5, usd: 0.01, samples: [] },
  }
  const s = parseSaved(old)
  expect(s?.totals.byModel).toEqual({})
  expect(s?.totals.lastModel).toBe(null)
  expect(s?.totals.input).toBe(5)
})

test('composeLine assembles every segment', () => {
  const line = composeLine({
    running: true,
    elapsedMs: 65_000,
    model: 'claude-opus-4-7',
    totals: {
      input: 5000,
      output: 1200,
      cacheRead: 180_000,
      cacheWrite: 1000,
      turns: 2,
      turnMs: 0,
      byModel: {},
      lastModel: null,
    },
    meter: {
      tokens: 90_000,
      window: 200_000,
      percent: 45,
      usd: 0.42,
      samples: [[0, 0], [60_000, 60_000]],
    },
    cost: { usd: 0.42, custom: false },
  })
  expect(line).toContain('⚡ 1m05s · turn 3')
  expect(line).toContain('opus-4-7')
  expect(line).toContain('↑186.0k ↓1.2k')
  expect(line).toContain('cache 97%')
  expect(line).toContain('ctx 45% · 90.0k/200.0k')
  expect(line).toContain('≈2m20s to full')
  expect(line).toContain('$0.42')
})

test('composeLine marks custom-priced cost with ≈', () => {
  const line = composeLine({
    running: false,
    elapsedMs: 0,
    model: null,
    totals: T0,
    meter: { tokens: null, window: 0, percent: null, usd: null, samples: [] },
    cost: { usd: 1.5, custom: true },
  })
  expect(line).toContain('≈$1.50')
})

test('composeLine drops unknown segments when idle', () => {
  const line = composeLine({
    running: false,
    elapsedMs: 0,
    model: null,
    totals: T0,
    meter: { tokens: null, window: 0, percent: null, usd: null, samples: [] },
    cost: null,
  })
  expect(line).toBe('✓ idle │ ↑0 ↓0')
})
