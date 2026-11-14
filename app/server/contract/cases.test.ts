import { expect, test } from 'vitest';
import { covers, normalize } from './cases.ts';

const ctx = { tmp: '/tmp/x', repo: '/repo', home: '/home/u', ports: [7860] };

test('normalize replaces the hash of a built asset: the record survives a client change', () => {
  const html = '<script src="/assets/index-DopSxb7D.js"></script><link href="/assets/Topology-a_B-9xYz.css">';
  expect(normalize(html, ctx)).toBe(
    '<script src="/assets/index-<hash>.js"></script><link href="/assets/Topology-<hash>.css">',
  );
});

test('covers matches a parameter segment, ignores a query string, and tells literal segments apart', () => {
  expect(covers('GET /api/profiles/:id', { method: 'GET', path: '/api/profiles/12' })).toBe(true);
  expect(covers('GET /api/profiles/:id', { method: 'GET', path: '/api/profiles/12?x=1' })).toBe(true);
  expect(covers('GET /api/profiles/:id', { method: 'GET', path: '/api/profiles' })).toBe(false);
  expect(covers('GET /api/profiles/:id', { method: 'GET', path: '/api/profiles/12/export' })).toBe(false);
  expect(covers('GET /api/profiles/:id', { method: 'DELETE', path: '/api/profiles/12' })).toBe(false);
  expect(covers('GET /api/profiles/export', { method: 'GET', path: '/api/profiles/export' })).toBe(true);
  expect(covers('GET /api/profiles/export', { method: 'GET', path: '/api/profiles/12' })).toBe(false);
  expect(covers('GET /api/profiles/:id', { method: 'GET', path: '/api/profiles/' })).toBe(false);
});
