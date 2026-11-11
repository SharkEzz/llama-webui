import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { CodeTextarea } from '@/components/CodeTextarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { formatEnv, parseEnv } from '@/features/profiles/argsText';
import { highlightEnv } from '@/features/profiles/highlight';
import { formatBytes } from '@/lib/format';

/** Environment variables, `KEY=value` per line, committed on blur when they parse and changed. */
export function EnvField(props: {
  id: string;
  hint: ReactNode;
  value: Record<string, string>;
  error?: string;
  onCommit(env: Record<string, string>): void;
}) {
  const saved = formatEnv(props.value);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const parsed = parseEnv(draft);
  const error = 'error' in parsed ? String(parsed.error) : props.error;
  return (
    <div className="flex flex-col gap-1.5">
      <CodeTextarea
        id={props.id}
        aria-label="Environment variables"
        value={draft}
        onChange={setDraft}
        onBlur={() => {
          if (!('error' in parsed) && formatEnv(parsed) !== saved) props.onCommit(parsed);
        }}
        highlight={highlightEnv}
        placeholder={'CUDA_VISIBLE_DEVICES=0,1\nGGML_CUDA_P2P=1'}
        aria-invalid={!!error}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      )}
    </div>
  );
}

/** Text setting committed on blur or Enter (only when it changed). */
export function TextField(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  value: string;
  error?: string;
  inputMode?: 'numeric';
  placeholder?: string;
  onCommit(v: string): void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft.trim() !== props.value) props.onCommit(draft.trim());
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        value={draft}
        inputMode={props.inputMode}
        placeholder={props.placeholder}
        className="font-mono"
        aria-invalid={!!props.error}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {props.error ? (
        <p className="text-xs text-destructive">{props.error}</p>
      ) : (
        props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>
      )}
    </div>
  );
}

export function SwitchRow(props: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange(on: boolean): void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={props.id}>{props.label}</Label>
        {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
      </div>
      <Switch id={props.id} checked={props.checked} onCheckedChange={props.onChange} />
    </div>
  );
}

/** One switch per GPU: a hidden card is no longer read (hiddenGpus setting, by bus id). */
export function GpuSwitches({
  gpus,
  hidden,
  onChange,
}: {
  gpus: { busId: string; name: string; vramTotalBytes: number }[];
  hidden: string[];
  onChange(hidden: string[]): void;
}) {
  return gpus.map((g) => (
    <SwitchRow
      key={g.busId}
      id={`gpu-${g.busId}`}
      label={g.name}
      hint={`${g.busId}${g.vramTotalBytes > 0 ? `, ${formatBytes(g.vramTotalBytes, 0)}` : ''}`}
      checked={!hidden.includes(g.busId)}
      onChange={(on) => onChange(on ? hidden.filter((b) => b !== g.busId) : [...hidden, g.busId])}
    />
  ));
}
