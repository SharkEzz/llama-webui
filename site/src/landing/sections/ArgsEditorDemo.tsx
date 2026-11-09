import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useOnScreen, usePrefersReducedMotion } from '../useSimulation';

/** The 27B profile's arguments, before the line being typed. */
const BASE = ['-c 32768', '-ngl 99', '-dev CUDA0,CUDA1', '-ts 51,58', '-sm layer', '--spec-type draft-mtp'];

/** Suggestions and help as the app derives them from `llama-server --help` (testdata/llama-server-help.txt). */
const FLAGS: Record<string, { value: string; help: string }> = {
  '--fim-qwen-1.5b-default': {
    value: '',
    help: 'use default Qwen 2.5 Coder 1.5B (note: can download weights from the internet)',
  },
  '--fim-qwen-3b-default': {
    value: '',
    help: 'use default Qwen 2.5 Coder 3B (note: can download weights from the internet)',
  },
  '--flash-attn': { value: '[on|off|auto]', help: "set Flash Attention use ('on', 'off', or 'auto', default: 'auto')" },
};

interface Step {
  /** Delay before this step, in ms. */
  wait: number;
  line: string;
  suggestions?: string[];
  active?: number;
}

const ALL = Object.keys(FLAGS);
const STEPS: Step[] = [
  { wait: 900, line: '' },
  { wait: 140, line: '-' },
  { wait: 140, line: '--' },
  { wait: 160, line: '--f', suggestions: ALL, active: 0 },
  { wait: 900, line: '--fl', suggestions: ['--flash-attn'], active: 0 },
  { wait: 1100, line: '--flash-attn ' },
  { wait: 450, line: '--flash-attn o' },
  { wait: 140, line: '--flash-attn on' },
];
/** Shown while still: the moment with the most to see. */
const STILL = 3;
const HOLD_MS = 4000;

/** Syntax colors of the app's editor (web/src/features/profiles/highlight.tsx): known flags blue, unknown amber. */
function Line({ text }: { text: string }) {
  return text.split(/(\s+)/).map((tok, i) => {
    const key = `${i}-${tok}`;
    if (!tok.startsWith('-') || tok.length < 2 || /^-\d/.test(tok)) return <span key={key}>{tok}</span>;
    const known = tok in FLAGS || BASE.some((l) => l.startsWith(`${tok} `));
    return (
      <span
        key={key}
        className={known ? 'text-tone-blue' : 'text-tone-amber underline decoration-tone-amber/70 decoration-dotted'}
      >
        {tok}
      </span>
    );
  });
}

/**
 * The profile editor's argument field typing `--fl` and accepting the suggestion, looped while on screen. Purely an
 * illustration: hidden from assistive technologies, which get the card's text.
 */
export function ArgsEditorDemo() {
  const reduced = usePrefersReducedMotion();
  const [ref, onScreen] = useOnScreen<HTMLDivElement>();
  const [index, setIndex] = useState(STILL);
  const playing = onScreen && !reduced;

  useEffect(() => {
    if (!playing) return;
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      setIndex(i);
      const wait = i === STEPS.length - 1 ? HOLD_MS : STEPS[i + 1]!.wait;
      i = (i + 1) % STEPS.length;
      timer = setTimeout(next, wait);
    };
    timer = setTimeout(next, STEPS[0]!.wait);
    return () => clearTimeout(timer);
  }, [playing]);

  const step = STEPS[playing ? index : STILL]!;

  return (
    <div ref={ref} className="mx-6 mb-6" aria-hidden="true">
      <p className="mb-2 text-sm font-medium">llama-server arguments</p>
      <div className="relative">
        <div className="min-h-72 rounded-lg border border-ring bg-input/30 px-3 py-2.5 font-mono text-sm leading-6 ring-3 ring-ring/30">
          {BASE.map((l) => (
            <div key={l}>
              <Line text={l} />
            </div>
          ))}
          <div>
            <Line text={step.line} />
            <span className="ml-px inline-block h-4 w-px translate-y-0.5 bg-foreground motion-safe:animate-pulse" />
          </div>
        </div>
        {step.suggestions && (
          <ul
            className="absolute inset-x-2 z-10 rounded-lg border border-border bg-popover p-1 shadow-surface"
            style={{ top: `calc(0.625rem + ${BASE.length + 1} * 1.5rem + 0.25rem)` }}
          >
            {step.suggestions.map((name, i) => (
              <li
                key={name}
                className={cn(
                  'flex items-baseline gap-3 rounded-md px-2 py-1.5',
                  i === step.active && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="shrink-0 font-mono text-xs">
                  {name}
                  {FLAGS[name]?.value && <span className="text-muted-foreground"> {FLAGS[name].value}</span>}
                </span>
                <span className="truncate text-xs text-muted-foreground">{FLAGS[name]?.help}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
