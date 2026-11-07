import { PRESETS } from '@llama-webui/shared';
import { Target } from 'lucide-react';
import { GlassCard } from '@/components/glass/GlassCard';
import { useTuning } from '@/lib/tuning';
import { cn } from '@/lib/utils';

/** L'objectif de la recommandation et du classement des sweeps. */
export function PresetPicker() {
  const preset = useTuning((s) => s.preset);
  return (
    <GlassCard title="Préréglage" icon={Target}>
      <div role="radiogroup" aria-label="Préréglage" className="flex flex-col gap-1">
        {PRESETS.map((p) => {
          const active = p.id === preset;
          return (
            // Radios natifs (masqués) : Tab entre dans le groupe, les flèches changent de préréglage.
            <label
              key={p.id}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50',
                active ? 'border-primary/40 bg-accent text-accent-foreground' : 'border-transparent hover:bg-muted',
              )}
            >
              <input
                type="radio"
                name="tuning-preset"
                className="sr-only"
                checked={active}
                onChange={() => useTuning.getState().setPreset(p.id)}
              />
              <span className="text-sm font-medium">{p.label}</span>
              <span className="text-xs text-muted-foreground">{p.hint}</span>
            </label>
          );
        })}
      </div>
    </GlassCard>
  );
}
