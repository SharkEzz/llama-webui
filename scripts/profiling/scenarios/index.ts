// The scenarios, by name: each one returns its part of results.json.
import type { Scenario } from '../measure.ts';
import type { ScenarioName } from '../results.ts';
import { idle } from './idle.ts';
import { startup } from './startup.ts';

const later = <K extends ScenarioName>(name: K): Scenario<K> => ({
  name,
  run: () => Promise.reject(new Error(`the ${name} scenario is not implemented yet`)),
});

export const SCENARIO_RUNNERS: { [K in ScenarioName]: Scenario<K> } = {
  startup,
  idle,
  load: later('load'),
  launch: later('launch'),
  dashboard: later('dashboard'),
  soak: later('soak'),
  aurora: later('aurora'),
  generation: later('generation'),
  chat: later('chat'),
  pages: later('pages'),
  api: later('api'),
  tps: later('tps'),
  collectors: later('collectors'),
};
