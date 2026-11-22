// The scenarios, by name: each one returns its part of results.json.
import type { Scenario } from '../measure.ts';
import type { ScenarioName } from '../results.ts';
import { aurora } from './aurora.ts';
import { dashboard } from './dashboard.ts';
import { idle } from './idle.ts';
import { launch } from './launch.ts';
import { load } from './load.ts';
import { soak } from './soak.ts';
import { startup } from './startup.ts';

const later = <K extends ScenarioName>(name: K): Scenario<K> => ({
  name,
  run: () => Promise.reject(new Error(`the ${name} scenario is not implemented yet`)),
});

export const SCENARIO_RUNNERS: { [K in ScenarioName]: Scenario<K> } = {
  startup,
  idle,
  load,
  launch,
  dashboard,
  soak,
  aurora,
  generation: later('generation'),
  chat: later('chat'),
  pages: later('pages'),
  api: later('api'),
  tps: later('tps'),
  collectors: later('collectors'),
};
