import { String as Str } from 'effect';

const PARAGRAPH =
  'The lighthouse stood at the end of the pier, battered by the waves for more than a century. Every evening, the keeper climbed the hundred and twelve steps, ' +
  'cleaned the lens, checked the wick and recorded in his logbook the direction of the wind, the height of the swell and the ships sighted offshore. ';

/**
 * A fixed text of about `tokens` tokens (≈ 4 characters each), identical from one run to the next (copied from
 * llama-tui).
 */
export const promptOf = (tokens: number): string => {
  const chars = tokens * 4;
  return Str.slice(0, chars)(Str.repeat(Math.ceil(chars / PARAGRAPH.length))(PARAGRAPH));
};

/**
 * The warm-up prompt: a sentence, not a word. llama.cpp segfaults on a 2-token prompt with -sm tensor and an MTP draft
 * (`Hello.` did, every time), and a real request is never that short anyway.
 */
export const WARMUP_PROMPT = 'Write one short sentence about the sea.';

/** The instruction after the filler text: a fresh generation, not a copy. */
export const STORY =
  'Starting from this text, write a new and original story, with different characters and a different setting.';
