const PARAGRAPH =
  'The lighthouse stood at the end of the pier, battered by the waves for more than a century. Every evening, the keeper climbed the hundred and twelve steps, ' +
  'cleaned the lens, checked the wick and recorded in his logbook the direction of the wind, the height of the swell and the ships sighted offshore. ';

/** A fixed text of about `tokens` tokens (≈ 4 characters each), identical from one run to the next (copied from llama-tui). */
export function promptOf(tokens: number): string {
  const chars = tokens * 4;
  return PARAGRAPH.repeat(Math.ceil(chars / PARAGRAPH.length)).slice(0, chars);
}
