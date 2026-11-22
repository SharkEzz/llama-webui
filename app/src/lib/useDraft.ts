import { type Dispatch, type SetStateAction, useState } from 'react';

/**
 * A draft of `value` that the user edits, reset to `value` each time it changes (a save, a reload). The reset happens
 * in the render that sees the new value (React's "adjusting state when a prop changes"), not in an effect afterwards.
 */
export function useDraft<T>(value: T): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (!Object.is(value, seen)) {
    setSeen(value);
    setDraft(value);
  }
  return [draft, setDraft];
}
