/** A named SSE event, data as single-line JSON. */
export const formatSse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
