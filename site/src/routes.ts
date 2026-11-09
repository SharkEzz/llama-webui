import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';
import { contentRoutes } from './lib/content.ts';

// Every .mdx file under content/ becomes a prerendered page (see react-router.config.ts).
const contentDir = fileURLToPath(new URL('../content', import.meta.url));
const pages = contentRoutes(readdirSync(contentDir, { recursive: true, encoding: 'utf8' }));

export default [
  index('routes/home.tsx'),
  layout('routes/docs-layout.tsx', [...pages.map((p) => route(p.path, `../content/${p.file}`))]),
  route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig;
