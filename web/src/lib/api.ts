export interface ApiIssue {
  path: (string | number)[]
  message: string
}

export class ApiError extends Error {
  readonly status: number
  /** Détail zod renvoyé par l'API pour un 400 (champ par champ). */
  readonly issues: ApiIssue[]
  constructor(status: number, message: string, issues: ApiIssue[] = []) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.issues = issues
  }
}

/** Appel JSON vers /api ; lève ApiError si la réponse n'est pas 2xx. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  let res: Response
  try {
    res = await fetch(`/api${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, "Serveur llama-webui injoignable")
  }
  const text = await res.text()
  let body: unknown = undefined
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `Erreur HTTP ${res.status}`
    const issues =
      typeof body === "object" && body !== null && "issues" in body && Array.isArray(body.issues) ? (body.issues as ApiIssue[]) : []
    throw new ApiError(res.status, message, issues)
  }
  return body as T
}

export interface Health {
  ok: boolean
  version: string
  uptimeMs: number
}

export const getHealth = () => api<Health>("/health")
