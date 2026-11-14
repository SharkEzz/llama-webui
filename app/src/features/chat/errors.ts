import { describeIssue, RequestInvalid, type Sampling } from '@llama-webui/shared';
import { errorTag } from '@/lib/api';

const FIELDS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'presence_penalty',
  'repeat_penalty',
  'max_tokens',
  'seed',
  'systemPrompt',
] as const satisfies ReadonlyArray<keyof Sampling | 'systemPrompt'>;

/** A field of the conversation settings that shows an error. */
export type Field = (typeof FIELDS)[number];

export type FieldErrors = Partial<Record<Field, string>>;

const isField = (key: string | undefined): key is Field => FIELDS.some((f) => f === key);

/**
 * The message of each settings field a failed save names: an issue goes to the field of its path (`sampling.top_k` →
 * `top_k`, `systemPrompt`); what names no field (an unknown key, an unreachable server) goes to the field being saved.
 */
export function fieldErrors(error: unknown, saved: Field): FieldErrors {
  if (errorTag(error) === 'RequestInvalid' && error instanceof RequestInvalid) {
    const out: FieldErrors = {};
    for (const issue of error.issues) {
      const key = issue.path[0] === 'sampling' ? issue.path[1] : issue.path[0];
      if (isField(key)) out[key] ??= issue.message;
      else out[saved] ??= describeIssue(issue);
    }
    return Object.keys(out).length > 0 ? out : { [saved]: error.message };
  }
  return { [saved]: error instanceof Error ? error.message : String(error) };
}
