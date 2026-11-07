import { basename } from 'node:path';
import tailwind from 'bun-plugin-tailwind';

/*
 * Interface web. En développement, l'import HTML de Bun.serve (HMR). En production, Bun.serve bundlerait aussi la page
 * à la volée, mais en un seul fichier : il ignore le découpage et inline les import() du routeur, si bien que chaque
 * page chargeait tout (three.js de la Topologie compris, ~1 Mo). Bun.build, lui, découpe : le front est construit au
 * démarrage, en mémoire (pas d'étape de build), et chaque page ne charge que ses chunks.
 */

/** Routes de l'UI pour Bun.serve : fichiers construits et fallback SPA (`/*`). */
export type WebRoutes = Record<string, Bun.HTMLBundle | Response>;

export async function buildWebRoutes(entry: string): Promise<WebRoutes> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    splitting: true,
    minify: true,
    // Chemins absolus : une adresse profonde (/chat/12) ne doit pas chercher ses chunks sous /chat/.
    publicPath: '/',
    plugins: [tailwind],
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `construction de l'interface web impossible (${entry})`);
  }
  const routes: WebRoutes = {};
  let html: string | null = null;
  for (const out of result.outputs) {
    const name = basename(out.path);
    if (name.endsWith('.html')) {
      html = await out.text();
      continue;
    }
    // Noms à empreinte de contenu : immuables.
    routes[`/${name}`] = new Response(await out.arrayBuffer(), {
      headers: { 'Content-Type': out.type, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  }
  if (html === null) throw new Error(`construction de l'interface web : pas de HTML produit (${entry})`);
  // Toute autre adresse sert l'application (fallback SPA) ; jamais en cache, elle désigne les chunks du moment.
  routes['/*'] = new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-cache' },
  });
  return routes;
}
