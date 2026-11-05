import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

/** Sert un fichier de distDir ; sinon index.html (fallback SPA) ; si le build est absent, 503 texte. */
export function serveStatic(req: Request, distDir: string): Response | undefined {
  if (req.method !== "GET" && req.method !== "HEAD") return undefined;
  const index = join(distDir, "index.html");
  if (!existsSync(index)) {
    return new Response("Build web absent : lancez bun run build\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return new Response("URL invalide", { status: 400 });
  }
  const file = normalize(join(distDir, pathname));
  if (file.startsWith(distDir + sep) && existsSync(file) && statSync(file).isFile()) {
    const headers: Record<string, string> = file.includes(`${sep}assets${sep}`)
      ? { "cache-control": "public, max-age=31536000, immutable" }
      : {};
    return new Response(Bun.file(file), { headers });
  }
  return new Response(Bun.file(index), { headers: { "cache-control": "no-cache" } });
}
