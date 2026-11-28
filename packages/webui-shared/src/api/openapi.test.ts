import { Array as Arr, Predicate, Record as Rec, String as Str } from 'effect';
import { OpenApi } from 'effect/http-api';
import { describe, expect, test } from 'vitest';
import { Api } from './Api.ts';

const spec = OpenApi.fromApi(Api);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const EXPECTED_MODELS = [
  'Health',
  'Settings',
  'SettingsPatched',
  'ProfileInput',
  'Profile',
  'ProfileExport',
  'ProfilesFile',
  'ImportResult',
  'Flag',
  'LogLine',
  'ServerView',
  'ServerProps',
  'HistoryReply',
  'Snapshot',
  'SystemInfo',
  'Topology',
  'ConversationSummary',
  'ConversationDetail',
  'ConversationPatch',
  'ChatMessage',
  'ModelList',
  'ModelDetail',
  'ModelUsage',
  'ModelDelete',
  'ModelDeleted',
  'HfStatus',
  'HfSearchHit',
  'HfRepo',
  'DownloadList',
  'DownloadItem',
  'DownloadRequest',
  'BenchDevice',
  'BenchDraft',
  'BenchSpec',
  'BenchRun',
  'BenchLive',
  'SweepSpec',
  'Sweep',
  'SweepLive',
  'ChecksReport',
  'TuningHardware',
  'DiskSpeed',
  'Estimate',
  'EstimateRequest',
  'PlanResult',
  'SetupReport',
] as const;

const isNonEmptyText = (value: unknown): boolean => Predicate.isString(value) && Str.isNonEmpty(Str.trim(value));

describe('OpenAPI specification completeness', () => {
  test('the API carries title and top-level description', () => {
    expect(spec.info.title).toBe('llama-webui API');
    expect(isNonEmptyText(spec.info.description)).toBe(true);
  });

  test('every API group tag has a description', () => {
    const tags = spec.tags;
    expect(tags).toHaveLength(15);
    const missing = Arr.map(
      Arr.filter(tags, (tag) => !isNonEmptyText(tag.description)),
      (tag) => tag.name,
    );
    expect(missing).toEqual([]);
  });

  test('every HTTP operation has a non-empty summary and description', () => {
    const missingSummary: Array<string> = [];
    const missingDescription: Array<string> = [];
    let count = 0;
    for (const [path, item] of Rec.toEntries(spec.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (op === undefined) continue;
        count += 1;
        const label = `${Str.toUpperCase(method)} ${path}`;
        if (!isNonEmptyText(op.summary)) missingSummary.push(label);
        if (!isNonEmptyText(op.description)) missingDescription.push(label);
      }
    }
    expect(count).toBe(67);
    expect(missingSummary).toEqual([]);
    expect(missingDescription).toEqual([]);
  });

  test('all core domain models are registered as named component schemas', () => {
    const schemas = spec.components.schemas;
    const missing = Arr.filter(EXPECTED_MODELS, (name) => !(name in schemas));
    expect(missing).toEqual([]);
  });

  test('every domain model schema has a non-empty description, and every error response has a descriptive message', () => {
    const schemas = spec.components.schemas;
    const missingModelDesc = Arr.map(
      Arr.filter(
        Rec.toEntries(schemas),
        ([name, schema]) => !/Encoded(?:_\d+)?$/.test(name) && !isNonEmptyText(schema.description),
      ),
      ([name]) => name,
    );
    expect(missingModelDesc).toEqual([]);

    const missingErrorResp: Array<string> = [];
    for (const [path, item] of Rec.toEntries(spec.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (op === undefined) continue;
        for (const [status, resp] of Rec.toEntries(op.responses)) {
          if (Number(status) < 400) continue;
          const desc = resp.description;
          // Effect defaults an undocumented TaggedError response description to its bare tag name (single identifier).
          if (!isNonEmptyText(desc) || /^[A-Za-z][A-Za-z0-9]*$/.test(Str.trim(desc))) {
            missingErrorResp.push(`${Str.toUpperCase(method)} ${path} ${status}: ${desc}`);
          }
        }
      }
    }
    expect(missingErrorResp).toEqual([]);
  });
});
