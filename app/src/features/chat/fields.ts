import type { Sampling } from '@llama-webui/shared';

/** A sampling field of the conversation settings: its key, its label, its key in llama-server's `/props`. */
export interface SamplingField {
  key: keyof Sampling;
  label: string;
  server: string;
  step?: string;
}

/** The sampling fields of the settings panel, in order (the fields `fieldErrors` puts an issue on, with the prompt). */
export const SAMPLING_FIELDS: ReadonlyArray<SamplingField> = [
  { key: 'temperature', label: 'Temperature', server: 'temperature', step: '0.05' },
  { key: 'top_p', label: 'Top-p', server: 'top_p', step: '0.01' },
  { key: 'top_k', label: 'Top-k', server: 'top_k' },
  { key: 'min_p', label: 'Min-p', server: 'min_p', step: '0.01' },
  { key: 'presence_penalty', label: 'Presence penalty', server: 'presence_penalty', step: '0.1' },
  { key: 'repeat_penalty', label: 'Repeat penalty', server: 'repeat_penalty', step: '0.05' },
  { key: 'max_tokens', label: 'Max tokens', server: 'n_predict' },
  { key: 'seed', label: 'Seed', server: 'seed' },
];
