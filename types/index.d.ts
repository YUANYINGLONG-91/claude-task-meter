export type Spend = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Totals = Spend & {
  turns: number
  turnMs: number
  /** Per-model-id totals, so custom pricing can price each model at its own rates */
  byModel: Record<string, Spend>
  /** The model of the last turn that reported usage */
  lastModel: string | null
}

export type Meter = {
  tokens: number | null
  window: number
  percent: number | null
  usd: number | null
  samples: [number, number][]
}

declare module 'claude-code' {
  interface PluginState {
    'task-meter': { totals: Totals; meter: Meter }
  }
}
