export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
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
    throw new ApiError(res.status, message)
  }
  return body as T
}

export interface Health {
  ok: boolean
  version: string
  uptimeMs: number
}

export const getHealth = () => api<Health>("/health")
