// Ported from web/src/components/glass/Gauge.tsx (keep both visually in sync).
import type { Tone } from './tones';
import { TONE_VAR } from './tones';

interface GaugeProps {
  value: number;
  label: string;
  size?: number;
  tone?: Tone;
}

const SWEEP = 0.75; // 270° arc

/** 270° circular gauge, open at the bottom, percentage in the center. */
export function Gauge({ value, label, size = 84, tone = 'blue' }: GaugeProps) {
  const stroke = Math.max(6, Math.round(size / 14));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const arc = circumference * SWEEP;
  const ratio = Math.min(1, Math.max(0, value / 100));

  return (
    <figure className="inline-flex flex-col items-center gap-1.5" style={{ width: size }}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rotate-135" aria-hidden="true">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--border)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arc} ${circumference}`}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={TONE_VAR[tone]}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arc} ${circumference}`}
            strokeDashoffset={arc * (1 - ratio)}
            className="transition-[stroke-dashoffset] duration-700 ease-out"
            opacity={ratio === 0 ? 0 : 1}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="num font-medium leading-none" style={{ fontSize: size * 0.22 }}>
            {Math.round(value)}
            <span className="ml-0.5 font-sans text-muted-foreground" style={{ fontSize: size * 0.12 }}>
              %
            </span>
          </span>
        </div>
      </div>
      <figcaption className="text-center text-xs leading-tight text-muted-foreground">{label}</figcaption>
    </figure>
  );
}
