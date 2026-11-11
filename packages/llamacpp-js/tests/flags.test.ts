import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catalogFrom, complete, describeFlag, flagOf, flagSuggestions, parseHelp, unknownFlags } from '../src/flags.ts';
import { fixture } from './helpers.ts';

const HELP = await fixture('llama-server-help.txt');
const catalog = parseHelp(HELP);

describe('parseHelp', () => {
  test('one flag per entry of the help, each alias known', () => {
    assert.equal(catalog.flags.length, 47);
    assert.equal(catalog.byName.get('-c'), catalog.byName.get('--ctx-size')!);
    assert.equal(catalog.byName.get('--n-gpu-layers'), catalog.byName.get('-ngl')!);
  });

  test("names, value and help, the help's continuation lines joined", () => {
    assert.deepEqual(flagOf(catalog, '--ctx-size'), {
      names: ['-c', '--ctx-size'],
      value: 'N',
      help: 'size of the prompt context (default: 0, 0 = loaded from model) (env: LLAMA_ARG_CTX_SIZE)',
      section: 'common params',
    });
    assert.deepEqual(flagOf(catalog, '-ngl')?.names, ['-ngl', '--gpu-layers', '--n-gpu-layers']);
    assert.deepEqual(flagOf(catalog, '--perf')?.names, ['--perf', '--no-perf']);
    assert.equal(flagOf(catalog, '--perf')?.value, undefined);
    assert.equal(flagOf(catalog, '--swa-full')?.value, undefined);
    assert.equal(flagOf(catalog, '-fa')?.value, '[on|off|auto]');
    assert.equal(flagOf(catalog, '--lora-scaled')?.value, 'FNAME:SCALE,...');
    assert.deepEqual(flagOf(catalog, '-ncmoe')?.names, ['-ncmoe', '--n-cpu-moe']);
  });

  test('a value too long for the names column puts the help on the next line', () => {
    assert.deepEqual(flagOf(catalog, '-ot'), {
      names: ['-ot', '--override-tensor'],
      value: '<tensor name pattern>=<buffer type>,...',
      help: 'override tensor buffer type (env: LLAMA_ARG_OVERRIDE_TENSOR)',
      section: 'common params',
    });
    assert.equal(flagOf(catalog, '--split-mode')?.value, '{none,layer,row,tensor}');
    assert.match(
      flagOf(catalog, '--split-mode')?.help ?? '',
      /^how to split the model across multiple GPUs, one of: - none: use one GPU only/,
    );
  });

  test('each flag is in the section that lists it', () => {
    assert.equal(flagOf(catalog, '--temp')?.section, 'sampling params');
    assert.equal(flagOf(catalog, '--jinja')?.section, 'example-specific params');
  });

  test('text that is not a help gives no flag', () => {
    assert.deepEqual(parseHelp('').flags, []);
    assert.deepEqual(parseHelp('error: unknown option\nusage: …\n').flags, []);
  });
});

describe('flagOf', () => {
  test('reads the flag of an argument written with =, ignores what is not a flag', () => {
    assert.equal(flagOf(catalog, '--ctx-size=8192')?.names[1], '--ctx-size');
    assert.equal(flagOf(catalog, '8192'), undefined);
    assert.equal(flagOf(catalog, '--nope'), undefined);
  });
});

describe('complete', () => {
  test('a single match is completed and followed by a space', () => {
    assert.deepEqual(complete(catalog, '--ctx'), { insert: '-size ', candidates: ['--ctx-size'] });
  });

  test('several matches: their common part, and the list', () => {
    assert.deepEqual(complete(catalog, '--cpu-'), {
      insert: '',
      candidates: [
        '--cpu-mask',
        '--cpu-mask-batch',
        '--cpu-moe',
        '--cpu-range',
        '--cpu-range-batch',
        '--cpu-strict',
        '--cpu-strict-batch',
      ],
    });
    assert.deepEqual(complete(catalog, '--cpu-r'), {
      insert: 'ange',
      candidates: ['--cpu-range', '--cpu-range-batch'],
    });
  });

  test('long names come before short ones', () => {
    assert.deepEqual(complete(catalog, '-n').candidates, ['-n', '-ncffn', '-ncmoe', '-ngl']);
    assert.deepEqual(complete(catalog, '-').candidates.slice(0, 2), ['--batch-size', '--cache-list']);
  });

  test('no match', () => {
    assert.deepEqual(complete(catalog, '--zzz'), { insert: '', candidates: [] });
  });
});

describe('unknownFlags', () => {
  test('flags the installed llama-server does not list; values and negative numbers are not flags', () => {
    assert.deepEqual(
      unknownFlags(catalog, ['--foo', '-ngl', '99', '--keep', '-1', '--ctx-size=4096', '--bar=1', '-']),
      ['--foo', '--bar'],
    );
  });
});

describe('describeFlag', () => {
  test('names, value and help on one line, without the environment variable', () => {
    assert.equal(
      describeFlag(flagOf(catalog, '-c')!),
      '-c, --ctx-size N — size of the prompt context (default: 0, 0 = loaded from model)',
    );
    assert.equal(
      describeFlag(flagOf(catalog, '--swa-full')!),
      '--swa-full — use full-size SWA cache (default: false) [(more info)](https://github.com/ggml-org/llama.cpp/pull/13194#issuecomment-2868343055)',
    );
  });
});

describe('catalogFrom', () => {
  test('rebuilds the name index from the flag list sent by the API', () => {
    const c = catalogFrom(JSON.parse(JSON.stringify(catalog.flags)));
    assert.equal(c.flags.length, 47);
    assert.equal(c.byName.get('-ngl'), c.byName.get('--n-gpu-layers')!);
  });
});

describe('flagSuggestions', () => {
  test('a word that is already a complete flag gets no suggestion (Enter must not swap it for a longer one)', () => {
    assert.deepEqual(flagSuggestions(catalog, '--cpu-range', 8), []);
    assert.deepEqual(flagSuggestions(catalog, '-c', 8), []);
  });

  test('an unfinished word gets the flags it starts, at most max', () => {
    assert.deepEqual(flagSuggestions(catalog, '--cpu-r', 8), ['--cpu-range', '--cpu-range-batch']);
    assert.equal(flagSuggestions(catalog, '--cpu-', 3).length, 3);
  });

  test('values and flags written with = get no suggestion', () => {
    assert.deepEqual(flagSuggestions(catalog, '8192', 8), []);
    assert.deepEqual(flagSuggestions(catalog, '--ctx=1', 8), []);
    assert.deepEqual(flagSuggestions(catalog, '', 8), []);
  });
});
