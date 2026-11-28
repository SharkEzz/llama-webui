import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api';
import { SetupReport } from '../setup.ts';

/** The first-run setup report. */
export class SetupApi extends HttpApiGroup.make('setup')
  .add(
    HttpApiEndpoint.get('setup', '/api/setup', { success: SetupReport }).annotateMerge(
      OpenApi.annotations({
        summary: 'Run first-run setup checklist',
        description:
          'Checks `llama-server` binary resolution and version, `llama-bench` devices, `modelsDir` contents, NVIDIA/perf telemetry readiness, and network exposure.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Setup',
      description: 'First-run readiness checklist for the Home page.',
    }),
  ) {}
