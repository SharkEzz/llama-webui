import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { formatBytes } from '@/lib/format';

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
