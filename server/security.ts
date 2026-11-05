import { isIP } from "node:net";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function forbidden(message: string, status = 403): Response {
  return Response.json({ error: message }, { status });
}

/** Nom d'hôte sûr : localhost ou adresse IP littérale. Un nom de domaine peut être rebindé vers 127.0.0.1. */
function trustedHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || isIP(h) !== 0;
}

/**
 * Protège l'API locale sans authentification contre les autres sites ouverts dans le navigateur :
 * - DNS rebinding : l'en-tête Host doit être localhost ou une IP ;
 * - requêtes inter-sites : un Origin présent doit être celui de la page (même schéma, hôte, port) ;
 * - CSRF par « requête simple » : une écriture avec un corps doit être en application/json.
 * Retourne une réponse d'erreur, ou undefined si la requête passe.
 */
export function guard(req: Request): Response | undefined {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return forbidden("Hôte invalide");
  }
  if (!trustedHostname(hostname)) return forbidden("Hôte non autorisé");

  const origin = req.headers.get("origin");
  if (origin !== null && origin !== `${url.protocol}//${host}`) return forbidden("Origine non autorisée");

  if (MUTATING.has(req.method)) {
    const type = req.headers.get("content-type");
    const json = type !== null && /^application\/json\b/i.test(type);
    if ((type !== null && !json) || (req.body !== null && !json)) {
      return forbidden("Corps JSON attendu (content-type: application/json)", 415);
    }
  }
  return undefined;
}
