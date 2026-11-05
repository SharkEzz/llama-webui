import type { ConversationDetail, ConversationSummary } from "@llama-webui/shared";
import type { ConversationsRepo } from "../db/conversations";
import type { ProfilesRepo } from "../db/profiles";
import { guarded, HttpError, idParam, jsonObject, notFound } from "../http";
import { profilePaths } from "../supervisor/args";

export interface ChatRouteDeps {
  conversations: ConversationsRepo;
  profiles: ProfilesRepo;
  activeProfileId: () => number | null;
  /** Une génération tourne pour cette conversation. */
  isLive?: (conversationId: number) => boolean;
}

export function chatRoutes({ conversations, profiles, activeProfileId, isLive = () => false }: ChatRouteDeps) {
  const detail = (id: number): ConversationDetail => {
    const c = conversations.get(id);
    if (!c) throw notFound("Conversation");
    return { ...c, live: isLive(id) };
  };

  return {
    "/api/chat": {
      GET: guarded(() => Response.json(conversations.list().map((c): ConversationSummary => ({ ...c, live: isLive(c.id) })))),
      POST: guarded(async (req) => {
        const body = await jsonObject(req);
        const id = body.profileId === undefined ? activeProfileId() : Number(body.profileId);
        if (id !== null && !Number.isInteger(id)) throw new HttpError(400, "profileId : entier attendu");
        const profile = id !== null ? profiles.get(id) : null;
        if (id !== null && !profile) throw notFound("Profil");
        const c = conversations.create({ profileId: profile?.id ?? null, modelPath: profile ? profilePaths(profile).model : null });
        return Response.json(detail(c.id), { status: 201 });
      }),
    },
    "/api/chat/:id": {
      GET: guarded((req) => Response.json(detail(idParam(req, "Conversation")))),
      PATCH: guarded(async (req) => {
        const id = idParam(req, "Conversation");
        conversations.patch(id, await jsonObject(req));
        return Response.json(detail(id));
      }),
      DELETE: guarded((req) => {
        conversations.delete(idParam(req, "Conversation"));
        return new Response(null, { status: 204 });
      }),
    },
  };
}
