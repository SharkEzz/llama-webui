import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { generateSiteOpenApi } from './siteOpenApi.ts';

test('generateSiteOpenApi writes openapi.json and offline scalar.html', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-site-openapi-'));
  try {
    const info = await generateSiteOpenApi(dir);
    expect(info.paths).toBeGreaterThanOrEqual(55);
    expect(info.operations).toBeGreaterThanOrEqual(67);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);

    const spec = JSON.parse(readFileSync(join(dir, 'openapi.json'), 'utf8')) as {
      openapi: string;
      info: { title: string; version: string };
      servers?: Array<{ url: string }>;
      paths: Record<string, unknown>;
    };
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('llama-webui API');
    expect(spec.info.version).toBe(info.version);
    expect(spec.servers?.[0]?.url).toBe('http://127.0.0.1:7860');
    expect(Object.keys(spec.paths)).toHaveLength(info.paths);

    const html = readFileSync(join(dir, 'scalar.html'), 'utf8');
    expect(html).toContain('window.Scalar.createApiReference');
    expect(html).toContain('"withDefaultFonts":false');
    expect(html).toContain('"agent":{"disabled":true}');
    expect(html).toContain('"hideDarkModeToggle":true');
    expect(html).toContain('http://127.0.0.1:7860');
    expect(html).not.toContain('<script src=');
    expect(html).not.toContain('cdn.jsdelivr.net');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
