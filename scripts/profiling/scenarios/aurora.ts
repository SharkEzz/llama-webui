// aurora: the Dashboard under CSS variants injected into the page, one window each, to tell what the aurora animation,
// the backdrop blur and the transitions each cost the compositor.
import { openPage } from '../browser.ts';
import { sleep } from '../instance.ts';
import { measure, type Scenario } from '../measure.ts';
import type { ScenarioResults } from '../results.ts';

const NO_BLUR = '*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
const VARIANTS = [
  { id: 'baseline', label: 'As is', css: '' },
  { id: 'no-aurora-animation', label: 'No aurora animation', css: '.glow{animation:none!important}' },
  { id: 'no-backdrop-blur', label: 'No backdrop blur', css: NO_BLUR },
  { id: 'no-animation-no-blur', label: 'Neither', css: `.glow{animation:none!important} ${NO_BLUR}` },
  {
    id: 'no-gauge-transition',
    label: 'No aurora animation, no transition',
    css: '.glow{animation:none!important} *,*::before,*::after{transition:none!important}',
  },
  { id: 'baseline-again', label: 'As is, again', css: '' },
];

export const aurora: Scenario<'aurora'> = {
  name: 'aurora',
  run: async (ctx) => {
    const page = await openPage(ctx, '/');
    const variants: ScenarioResults['aurora']['variants'] = [];
    for (const v of VARIANTS) {
      await page.evaluate(
        `(() => { const s = document.createElement('style'); s.id = 'profiling-variant'; s.textContent = ${JSON.stringify(v.css)}; document.head.append(s); })()`,
      );
      // The page settles under the new style before the window.
      await sleep(2000);
      const window = await measure(ctx, page, { id: v.id, label: v.label, ms: 25_000 });
      await page.evaluate("document.getElementById('profiling-variant').remove()");
      variants.push({ css: v.css, window });
      ctx.log(`${v.label}: chrome-gpu ${(window.procs.cpuPct['chrome-gpu'] ?? 0).toFixed(1)} %`);
    }
    return { variants };
  },
};
