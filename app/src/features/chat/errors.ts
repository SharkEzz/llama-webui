import { describeIssue, RequestInvalid } from '@llama-webui/shared';
import { errorTag } from '@/lib/api';
import { SAMPLING_FIELDS } from './fields';

/** A field of the conversation settings that shows an error: a sampling field of the panel, or the system prompt. */
export type Field = (typeof SAMPLING_FIELDS)[number]['key'] | 'systemPrompt';

const FIELDS: ReadonlyArray<Field> = [...SAMPLING_FIELDS.map((f) => f.key), 'systemPrompt'];

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
