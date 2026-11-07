import { TONE_VAR, type Tone } from "./tones"

interface GaugeProps {
  value: number
  max?: number
  label: string
  unit?: string
  size?: number
  tone?: Tone
}

const SWEEP = 0.75 // arc de 270°

/** Jauge circulaire 270°, ouverture en bas, valeur au centre. */
export function Gauge({ value, max = 100, label, unit = "%", size = 96, tone = "violet" }: GaugeProps) {
  const stroke = Math.max(6, Math.round(size / 14))
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const arc = circumference * SWEEP
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const display = Number.isInteger(value) ? value : value.toFixed(1)

  return (
    <figure className="inline-flex flex-col items-center gap-1.5" style={{ width: size }}>
      <div className="relative" style={{ width: size, height: size }}>
        {/* biome-ignore lint/a11y/useSemanticElements: jauge SVG : <meter> n'est pas applicable à un <svg> */}
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="rotate-135"
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={value}
        >
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
            style={{ transition: "stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1)" }}
            opacity={ratio === 0 ? 0 : 1}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="num font-medium leading-none" style={{ fontSize: size * 0.22 }}>
            {display}
            {unit && (
              <span className="ml-0.5 font-sans text-muted-foreground" style={{ fontSize: size * 0.12 }}>
                {unit}
              </span>
            )}
          </span>
        </div>
      </div>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  )
}
