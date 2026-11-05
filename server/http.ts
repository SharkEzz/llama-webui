import type { BunRequest, Server } from "bun";
import { ZodError } from "zod";
import { guard } from "./security";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} introuvable`);

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first && first.path.length > 0 ? ` (${first.path.join(".")})` : "";
    return Response.json({ error: `Données invalides : ${first?.message ?? "?"}${where}`, issues: err.issues }, { status: 400 });
  }
  if (err instanceof SyntaxError) return Response.json({ error: "JSON invalide" }, { status: 400 });
  console.error(err);
  return Response.json({ error: "Erreur interne" }, { status: 500 });
}

export type Handler = (
  req: BunRequest<string>,
  server: Server<undefined>,
) => Response | undefined | Promise<Response | undefined>;

/** Applique le garde (hôte, origine, JSON) puis le handler ; toute exception devient une réponse JSON. */
export function guarded(handler: Handler): Handler {
  return async (req, server) => {
    const refused = guard(req);
    if (refused) return refused;
    try {
      return await handler(req, server);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Paramètre de route entier positif (`:id`), sinon 404. */
export function idParam(req: BunRequest<string>, what: string): number {
  const raw = (req.params as Record<string, string>).id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw notFound(what);
  return id;
}

/** Corps JSON objet, sinon 400. */
export async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Objet JSON attendu");
  return body as Record<string, unknown>;
}
