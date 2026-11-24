export const THROUGHPUT = {
  gen: { title: 'Generation (tok/s)', label: 'Generation', color: 'var(--chart-1)' },
  pp: { title: 'Prompt (tok/s)', label: 'Prompt', color: 'var(--chart-2)' },
} as const;
export type ThroughputSeries = keyof typeof THROUGHPUT;
