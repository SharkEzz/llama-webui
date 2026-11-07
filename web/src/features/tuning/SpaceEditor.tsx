import { type BenchDevice, CACHE_TYPES, FLASH_ATTN, gpuDevices, SPLIT_MODES, serverArgs } from '@llama-webui/shared';
import { Plus, Sparkles, Waypoints, X } from 'lucide-react';
import { useState } from 'react';
import { GlassCard } from '@/components/glass/GlassCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTuning } from '@/lib/tuning';
import { cn } from '@/lib/utils';
import { PlanTable } from './PlanTable';

const show = (v: unknown) => (Array.isArray(v) ? v.join(',') : String(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const int = (t: string) => (/^\d+$/.test(t.trim()) ? Number(t.trim()) : null);
const list = (t: string) => {
  const xs = t
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  return xs.length >= 2 && xs.every((x) => Number.isFinite(x) && x >= 0) ? xs : null;
};

/** Motifs -ot proposés : ils visent les experts MoE (llama.cpp applique la première règle qui correspond). */
const OT_SUGGESTIONS = [
  'exps=CPU',
  'blk\\.(\\d|1\\d)\\.ffn_.*_exps=CPU',
  'blk\\.[0-9]\\.ffn_.*_exps=CPU',
  'ffn_.*_exps=Vulkan3',
];

/** L'espace de recherche : une ligne par flag, chaque valeur ajoutée multiplie les configurations. */
export function SpaceEditor() {
  const space = useTuning((s) => s.space);
  const base = useTuning((s) => s.base);
  const estimate = useTuning((s) => s.estimate);
  const hw = useTuning((s) => s.hardware);
  const modelPath = useTuning((s) => s.modelPath);
  const run = useTuning((s) => s.run);
  const includeUnfit = useTuning((s) => s.includeUnfit);
  const { setSpace, setBase, setRun, setIncludeUnfit } = useTuning.getState();
  const gpus = gpuDevices(hw?.devices ?? []);
  const baseArgs = serverArgs(base);
  const ncmoe = estimate?.params.ncmoe ?? 0;
  const around = ncmoe > 0 ? [ncmoe - 8, ncmoe - 4, ncmoe, ncmoe + 4, ncmoe + 8].filter((x) => x >= 0) : [0, 4, 8, 16];

  return (
    <GlassCard
      title="Espace de recherche"
      icon={Waypoints}
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={!estimate?.ok}
          onClick={() => useTuning.getState().suggestSpace()}
        >
          <Sparkles /> Partir de la recommandation
        </Button>
      }
    >
      {!modelPath ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Choisissez un modèle pour composer un sweep.</p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Base :</span>
            {baseArgs.length === 0 ? (
              <span className="text-muted-foreground">aucun flag (défauts de llama-bench)</span>
            ) : (
              <>
                <code className="rounded-md bg-well px-2 py-1 font-mono text-xs">{baseArgs.join(' ')}</code>
                <Button variant="ghost" size="xs" onClick={() => setBase({})}>
                  Vider
                </Button>
              </>
            )}
            <span className="w-full text-xs text-muted-foreground">
              Chaque valeur d'une ligne remplace celle de la base ; une ligne vide n'intervient pas.
            </span>
          </div>

          <div className="flex flex-col divide-y">
            <ValuesRow
              flag="-ngl"
              values={space.ngl ?? []}
              onChange={(ngl) => setSpace({ ngl })}
              parse={(t) => (t.trim() === 'all' ? 'all' : int(t)) ?? 'un nombre de couches ou « all »'}
              suggestions={['all']}
            />
            <ValuesRow
              flag="-ncmoe"
              values={space.ncmoe ?? []}
              onChange={(v) => setSpace({ ncmoe: v })}
              parse={(t) => int(t) ?? 'un entier'}
              suggestions={around}
              hint={ncmoe > 0 ? `autour de l'estimation (${ncmoe})` : undefined}
            />
            <DevRow gpus={gpus} values={space.dev ?? []} onChange={(dev) => setSpace({ dev })} />
            <ValuesRow
              flag="-ts"
              values={space.ts ?? []}
              onChange={(ts) => setSpace({ ts })}
              parse={(t) => list(t) ?? 'des proportions (3,1)'}
              hint="appliqué aux jeux de -dev de même longueur"
            />
            <ValuesRow
              flag="-ot"
              values={space.ot ?? []}
              onChange={(ot) => setSpace({ ot })}
              parse={(t) => (/^[^=,;]+=[^=,;]+$/.test(t.trim()) ? [t.trim()] : 'motif=buffer (ex. exps=CPU)')}
              suggestions={OT_SUGGESTIONS.map((o) => [o])}
              mono
              wide
            />
            <ToggleRow flag="-fa" options={FLASH_ATTN} values={space.fa ?? []} onChange={(fa) => setSpace({ fa })} />
            <ToggleRow
              flag="-ctk"
              options={CACHE_TYPES}
              values={space.ctk ?? []}
              onChange={(ctk) => setSpace({ ctk })}
            />
            <ToggleRow
              flag="-ctv"
              options={CACHE_TYPES}
              values={space.ctv ?? []}
              onChange={(ctv) => setSpace({ ctv })}
            />
            <ToggleRow flag="-sm" options={SPLIT_MODES} values={space.sm ?? []} onChange={(sm) => setSpace({ sm })} />
            <ValuesRow
              flag="-ub"
              values={space.ub ?? []}
              onChange={(ub) => setSpace({ ub })}
              parse={(t) => int(t) || 'un entier'}
              suggestions={[256, 512, 1024, 2048]}
            />
            <ValuesRow
              flag="-b"
              values={space.b ?? []}
              onChange={(b) => setSpace({ b })}
              parse={(t) => int(t) || 'un entier'}
              suggestions={[512, 2048, 4096]}
            />
            <ValuesRow
              flag="-t"
              values={space.t ?? []}
              onChange={(t) => setSpace({ t })}
              parse={(t) => int(t) || 'un entier'}
              suggestions={hw ? [...new Set([hw.cpu.physicalCores, hw.cpu.logicalThreads])] : []}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
            <Field label="Nom du sweep" id="sweep-name">
              <Input
                id="sweep-name"
                value={run.name}
                placeholder="automatique : modèle · préréglage · date"
                maxLength={80}
                onChange={(e) => setRun({ name: e.target.value })}
              />
            </Field>
            <NumField label="p (prompt)" value={run.p} onChange={(p) => setRun({ p })} />
            <NumField label="n (génération)" value={run.n} onChange={(n) => setRun({ n })} />
            <NumField
              label="r (répétitions)"
              value={run.r}
              onChange={(r) => setRun({ r })}
              hint="r ≥ 3 pour que l'écart-type ait un sens"
            />
          </div>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={includeUnfit} onCheckedChange={(v) => setIncludeUnfit(v === true)} />
            Inclure les configurations qui ne tiennent pas (elles finiront probablement en « Mémoire insuffisante »)
          </Label>

          <PlanTable />
        </div>
      )}
    </GlassCard>
  );
}

function Row({ flag, hint, children }: { flag: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-1.5 py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)]">
      <div className="flex flex-col">
        <span className="pt-1 font-mono text-sm">{flag}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ label, onRemove, mono }: { label: string; onRemove(): void; mono?: boolean }) {
  return (
    <Badge variant="secondary" className={cn('max-w-full gap-1 pr-0.5', mono && 'font-mono')}>
      <span className="truncate">{label}</span>
      <Button variant="ghost" size="icon-xs" className="size-4" onClick={onRemove} aria-label={`Retirer ${label}`}>
        <X />
      </Button>
    </Badge>
  );
}

function Suggestion({ label, onClick, mono }: { label: string; onClick(): void; mono?: boolean }) {
  return (
    <Button variant="ghost" size="xs" className={cn('text-muted-foreground', mono && 'font-mono')} onClick={onClick}>
      <Plus /> {label}
    </Button>
  );
}

function ValuesRow<T>(props: {
  flag: string;
  values: T[];
  onChange(v: T[]): void;
  parse(text: string): T | string;
  suggestions?: T[];
  hint?: string;
  mono?: boolean;
  wide?: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = (v: T) => {
    if (!props.values.some((x) => same(x, v))) props.onChange([...props.values, v]);
  };
  const submit = () => {
    if (!text.trim()) return;
    const v = props.parse(text);
    if (typeof v === 'string' && !(props.flag === '-ngl' && v === 'all')) return setError(v);
    add(v as T);
    setText('');
  };
  return (
    <Row flag={props.flag} hint={props.hint}>
      {props.values.map((v) => (
        <Chip
          key={show(v)}
          label={show(v)}
          mono={props.mono}
          onRemove={() => props.onChange(props.values.filter((x) => !same(x, v)))}
        />
      ))}
      <Input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        onBlur={submit}
        placeholder="ajouter…"
        aria-label={`Ajouter une valeur à ${props.flag}`}
        aria-invalid={error ? true : undefined}
        className={cn('h-7 font-mono text-xs', props.wide ? 'w-56' : 'w-24')}
      />
      {props.suggestions
        ?.filter((s) => !props.values.some((x) => same(x, s)))
        .map((s) => (
          <Suggestion key={show(s)} label={show(s)} mono={props.mono} onClick={() => add(s)} />
        ))}
      {error && <span className="w-full text-xs text-destructive">{error}</span>}
    </Row>
  );
}

function ToggleRow<T extends string>({
  flag,
  options,
  values,
  onChange,
}: {
  flag: string;
  options: readonly T[];
  values: T[];
  onChange(v: T[]): void;
}) {
  return (
    <Row flag={flag}>
      {options.map((o) => {
        const on = values.includes(o);
        return (
          <Button
            key={o}
            size="xs"
            variant={on ? 'secondary' : 'ghost'}
            aria-pressed={on}
            className={cn('font-mono', !on && 'text-muted-foreground')}
            onClick={() => onChange(on ? values.filter((x) => x !== o) : [...values, o])}
          >
            {o}
          </Button>
        );
      })}
    </Row>
  );
}

function DevRow({
  gpus,
  values,
  onChange,
}: {
  gpus: BenchDevice[];
  values: string[][];
  onChange(v: string[][]): void;
}) {
  const [draft, setDraft] = useState<string[]>([]);
  const add = (...sets: string[][]) => {
    const next = [...values];
    for (const s of sets) if (s.length > 0 && !next.some((x) => same(x, s))) next.push(s);
    onChange(next);
  };
  const cuda = gpus.filter((d) => d.backend === 'CUDA').map((d) => d.id);
  return (
    <Row flag="-dev" hint="un jeu de devices par configuration">
      {values.map((v) => (
        <Chip key={v.join()} label={v.join(',')} mono onRemove={() => onChange(values.filter((x) => !same(x, v)))} />
      ))}
      <div className="flex w-full flex-wrap items-center gap-3 pt-1">
        {gpus.map((d) => (
          <Label key={d.id} className="flex items-center gap-1.5 font-mono text-xs font-normal">
            <Checkbox
              checked={draft.includes(d.id)}
              onCheckedChange={(c) =>
                setDraft(
                  c
                    ? gpus.map((g) => g.id).filter((id) => id === d.id || draft.includes(id))
                    : draft.filter((x) => x !== d.id),
                )
              }
            />
            {d.id}
          </Label>
        ))}
        <Button
          size="xs"
          variant="outline"
          disabled={draft.length === 0}
          onClick={() => {
            add(draft);
            setDraft([]);
          }}
        >
          <Plus /> Ajouter ce jeu
        </Button>
        <Suggestion label="chaque carte seule" onClick={() => add(...gpus.map((d) => [d.id]))} />
        {cuda.length >= 2 && <Suggestion label="les CUDA" onClick={() => add(cuda)} />}
        {gpus.length >= 2 && <Suggestion label="toutes" onClick={() => add(gpus.map((d) => d.id))} />}
      </div>
    </Row>
  );
}

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange(v: number): void;
  hint?: string;
}) {
  const id = `sweep-${label.split(' ')[0]}`;
  return (
    <Field label={label} id={id} hint={hint}>
      <Input
        id={id}
        type="number"
        min={1}
        value={value}
        className="num"
        onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))}
      />
    </Field>
  );
}
