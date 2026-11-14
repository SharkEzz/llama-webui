import { describeIssue, ProfileNameTaken, RequestInvalid } from '@llama-webui/shared';
import { errorTag } from '@/lib/api';

const FIELDS = ['name', 'model', 'mmproj', 'cwd', 'host', 'port', 'args', 'env'] as const;
type Field = (typeof FIELDS)[number];

export type FieldErrors = Partial<Record<Field | 'form', string>>;

const isField = (key: string | undefined): key is Field => FIELDS.some((f) => f === key);

/**
 * The message of each form field a failed save names: an issue goes to its first path segment (`args.2` → `args`),
 * a taken name to `name`; `form` holds what names no field (an unknown key, an unreachable server).
 */
export function fieldErrors(error: unknown): FieldErrors {
  if (errorTag(error) === 'RequestInvalid' && error instanceof RequestInvalid) {
    const out: FieldErrors = {};
    for (const issue of error.issues) {
      const key = issue.path[0];
      if (isField(key)) out[key] ??= issue.message;
      else out.form ??= describeIssue(issue);
    }
    return Object.keys(out).length > 0 ? out : { form: error.message };
  }
  if (errorTag(error) === 'ProfileNameTaken' && error instanceof ProfileNameTaken) return { name: error.message };
  return { form: error instanceof Error ? error.message : String(error) };
}
