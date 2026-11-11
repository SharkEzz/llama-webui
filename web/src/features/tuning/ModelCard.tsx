import { serverArgs as argsOf, ignoredByBench, type ModelDetail, shellQuote, withCtx } from '@llama-webui/shared';
import { Box, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/glass/GlassCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ModelPicker } from '@/features/models/ModelPicker';
import { api } from '@/lib/api';
import { formatBytes, formatInt, formatParams } from '@/lib/format';
import { useProfiles } from '@/lib/profiles';
import { replacedProfileParams, useTuning } from '@/lib/tuning';

const NO_PROFILE = '__none';

/** Model to tune: from a profile (model, projector, other flags) or picked directly. */
export function ModelCard() {
  const modelPath = useTuning((s) => s.modelPath);
  const mmprojPath = useTuning((s) => s.mmprojPath);
  const profileId = useTuning((s) => s.profileId);
  const profileArgs = useTuning((s) => s.serverArgs);
  const estimateCtx = useTuning((s) => s.estimate?.ctx);
  // What the sweep carries: the profile's flags, plus the recommendation's -c when they set no context (#24).
  const serverArgs = withCtx(profileArgs, estimateCtx);
  const addedCtx = serverArgs !== profileArgs;
  const profileParams = useTuning((s) => s.profileParams);
  const pinned = useTuning((s) => s.pinned);
  const replaced = replacedProfileParams(profileParams, pinned);
  const replacedArgs = argsOf(replaced);
  const profiles = useProfiles((s) => s.profiles);
  const [info, setInfo] = useState<ModelDetail | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  useEffect(() => {
    void useProfiles.getState().reload();
  }, []);

  useEffect(() => {
    setInfo(null);
    setInfoError(null);
    if (!modelPath) return;
    let gone = false;
    void api<ModelDetail>(`/models/info?path=${encodeURIComponent(modelPath)}`).then(
      (d) => !gone && setInfo(d),
      (e: Error) => !gone && setInfoError(e.message),
    );
    return () => {
      gone = true;
    };
  }, [modelPath]);

  const items = [
    { value: NO_PROFILE, label: 'None: model only' },
    ...profiles.map((p) => ({ value: String(p.id), label: p.name })),
  ];
  const ignored = ignoredByBench(serverArgs);

  return (
    <GlassCard title="Model" icon={Box}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Start from a profile</Label>
          <Select
            items={items}
            value={profileId === null ? NO_PROFILE : String(profileId)}
            onValueChange={(v) => void useTuning.getState().fromProfile(v && v !== NO_PROFILE ? Number(v) : null)}
          >
            <SelectTrigger className="w-full" aria-label="Starting profile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <PathInput
          label="Model"
          kind="model"
          value={modelPath ?? ''}
          onCommit={(p) => useTuning.getState().setModel(p || null, mmprojPath)}
        />
        <PathInput
          label="Projector (optional)"
          kind="mmproj"
          value={mmprojPath ?? ''}
          onCommit={(p) => useTuning.getState().setModel(modelPath, p || null)}
        />

        {modelPath && !info && !infoError && <Skeleton className="h-16" />}
        {infoError && <p className="text-sm text-destructive">{infoError}</p>}
        {info && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-3 text-sm">
            <dt className="text-muted-foreground">Architecture</dt>
            <dd className="text-right font-mono text-xs">
              {info.arch} · {info.quant} · {formatParams(info.params)}
            </dd>
            <dt className="text-muted-foreground">Size</dt>
            <dd className="num text-right">{formatBytes(info.fileBytes)}</dd>
            <dt className="text-muted-foreground">Layers</dt>
            <dd className="num text-right">{info.blockCount}</dd>
            <dt className="text-muted-foreground">Experts</dt>
            <dd className="num text-right">
              {info.expertCount > 0 ? `${info.expertUsedCount} active of ${info.expertCount}` : 'dense'}
            </dd>
            <dt className="text-muted-foreground">Max context</dt>
            <dd className="num text-right">{formatInt(info.contextLength)}</dd>
          </dl>
        )}

        {serverArgs.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              Other profile flags (carried over to the created profile and the server validation)
            </span>
            <code className="rounded-md bg-well inset-shadow-well px-2.5 py-1.5 font-mono text-xs break-all">
              {shellQuote(serverArgs)}
            </code>
            {addedCtx && (
              <span className="text-xs text-muted-foreground">
                -c from the recommendation: the profile sets no context, and llama-server would allocate the model's
                full one.
              </span>
            )}
            {ignored.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Ignored by llama-bench: {ignored.map((i) => i.flag).join(', ')}
              </span>
            )}
          </div>
        )}

        {replacedArgs.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Profile flags replaced by the recommendation (pin them to keep them)
              </span>
              <Button variant="outline" size="xs" onClick={() => useTuning.getState().pin(replaced)}>
                <Lock /> Pin
              </Button>
            </div>
            <code className="rounded-md bg-well inset-shadow-well px-2.5 py-1.5 font-mono text-xs break-all">
              {shellQuote(replacedArgs)}
            </code>
          </div>
        )}
      </div>
    </GlassCard>
  );
}

function PathInput({
  label,
  kind,
  value,
  onCommit,
}: {
  label: string;
  kind: 'model' | 'mmproj';
  value: string;
  onCommit(p: string): void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const id = `tuning-${kind}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <InputGroup>
        <InputGroupInput
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text.trim() !== value && onCommit(text.trim())}
          onKeyDown={(e) => e.key === 'Enter' && onCommit(text.trim())}
          placeholder={kind === 'model' ? '/absolute/path/to/model.gguf' : '/absolute/path/to/mmproj.gguf'}
          className="font-mono text-xs"
        />
        <InputGroupAddon align="inline-end">
          <ModelPicker kind={kind} onSelect={onCommit} />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
