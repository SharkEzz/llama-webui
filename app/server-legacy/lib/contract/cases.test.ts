import { expect, test } from 'vitest';
import { normalize } from './cases';

const ctx = { tmp: '/tmp/x', repo: '/repo', home: '/home/u', ports: [7860] };

test('normalize replaces the hash of a built asset: the record survives a client change', () => {
  const html = '<script src="/assets/index-DopSxb7D.js"></script><link href="/assets/Topology-a_B-9xYz.css">';
  expect(normalize(html, ctx)).toBe(
    '<script src="/assets/index-<hash>.js"></script><link href="/assets/Topology-<hash>.css">',
  );
});
