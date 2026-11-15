import { expect, test } from 'vitest';
import { milestoneOf } from './inventory.ts';

test('milestoneOf places a test file in the milestone that ports it', () => {
  expect(milestoneOf('app/server/lifecycle.test.ts')).toBe('E1');
  expect(milestoneOf('app/server/lib/db/migrations.test.ts')).toBe('E1');
  expect(milestoneOf('app/server/lib/schemas.test.ts')).toBe('E2');
  expect(milestoneOf('app/server/lib/supervisor/supervisor.test.ts')).toBe('E3');
  expect(milestoneOf('app/server/lib/llamaFetch.test.ts')).toBe('E3');
  expect(milestoneOf('app/server/lib/collectors/nvml/monitor.test.ts')).toBe('E4');
  expect(milestoneOf('app/server/lib/chat/runs.test.ts')).toBe('E5');
  expect(milestoneOf('app/server/lib/hf/downloader.test.ts')).toBe('E6');
  expect(milestoneOf('app/server/lib/db/sweeps.test.ts')).toBe('E7');
  expect(milestoneOf('app/server/lib/tuning/estimate.test.ts')).toBe('E8');
  expect(milestoneOf('packages/webui-shared/src/format.test.ts')).toBe('keep');
  expect(milestoneOf('app/src/features/topology/layout.test.ts')).toBe('keep');
  expect(milestoneOf('scripts/release.test.ts')).toBe('keep');
});

test('milestoneOf throws on an unmapped file', () => {
  expect(() => milestoneOf('app/server/lib/new/thing.test.ts')).toThrow(
    'no milestone for app/server/lib/new/thing.test.ts',
  );
});
