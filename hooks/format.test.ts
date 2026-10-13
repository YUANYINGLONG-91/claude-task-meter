import { expect, test } from 'claude-code/testing'

import {
  cacheHitPct,
  composeLine,
  customCost,
  etaToFull,
  fmtDur,
  fmtTok,
  parsePricing,
} from './format'

const T0 = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  turnMs: 0,
  byModel: {},
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

test('composeLine assembles every segment', () => {
  const line = composeLine({
    running: true,
    elapsedMs: 65_000,
    totals: {
      input: 5000,
      output: 1200,
      cacheRead: 180_000,
      cacheWrite: 1000,
      turns: 2,
      turnMs: 0,
      byModel: {},
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
    totals: T0,
    meter: { tokens: null, window: 0, percent: null, usd: null, samples: [] },
    cost: null,
  })
  expect(line).toBe('✓ idle │ ↑0 ↓0')
})
