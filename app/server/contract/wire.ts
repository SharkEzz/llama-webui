// Raw HTTP/1.1 over node:net for the contract suite. Not fetch: the client sends exact bytes, and the behaviour
// under test depends on request framing (a body-less PATCH, a foreign Host header).
import { connect } from 'node:net';

export interface WireRequest {
  method: string;
  path: string;
  /** Sent as given (a `Host` here replaces the one taken from the base URL). */
  headers?: Record<string, string>;
  /** Sent with its `Content-Length`; without it, the request has neither `Content-Length` nor `Transfer-Encoding`. */
  body?: string;
}

export interface WireResponse {
  status: number;
  /** Lower-case names; a repeated header keeps its last value. */
  headers: Record<string, string>;
  body: string;
}

const CRLF = Buffer.from('\r\n');
const HEAD_END = Buffer.from('\r\n\r\n');

function encode(base: string, r: WireRequest): Buffer {
  const url = new URL(base);
  const headers: [string, string][] = [];
  const given = Object.entries(r.headers ?? {});
  if (!given.some(([k]) => k.toLowerCase() === 'host')) headers.push(['Host', url.host]);
  headers.push(...given, ['Connection', 'close']);
  const body = r.body === undefined ? null : Buffer.from(r.body);
  if (body) headers.push(['Content-Length', String(body.length)]);
  const head = `${r.method} ${r.path} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;
  return body ? Buffer.concat([Buffer.from(head), body]) : Buffer.from(head);
}

interface Head {
  status: number;
  headers: Record<string, string>;
  /** Offset of the body in the received bytes. */
  start: number;
}

function parseHead(data: Buffer): Head | null {
  const end = data.indexOf(HEAD_END);
  if (end < 0) return null;
  const [statusLine = '', ...lines] = data.subarray(0, end).toString('latin1').split('\r\n');
  const status = Number(statusLine.split(' ')[1]);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status, headers, start: end + HEAD_END.length };
}

/** The complete chunks of a chunked body (an incomplete last chunk is left out). */
function dechunk(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = data.indexOf(CRLF, at);
    if (eol < 0) break;
    const size = Number.parseInt(data.subarray(at, eol).toString('latin1'), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const from = eol + CRLF.length;
    if (data.length < from + size) break;
    parts.push(data.subarray(from, from + size));
    at = from + size + CRLF.length;
  }
  return Buffer.concat(parts);
}

function body(method: string, head: Head, data: Buffer): string {
  if (method === 'HEAD' || head.status === 204 || head.status === 304) return '';
  const rest = data.subarray(head.start);
  if (head.headers['transfer-encoding']?.toLowerCase() === 'chunked') return dechunk(rest).toString('utf8');
  const length = head.headers['content-length'];
  return (length === undefined ? rest : rest.subarray(0, Number(length))).toString('utf8');
}

/** One request on its own connection (`Connection: close`); resolves once the server closes it. */
export function request(base: string, r: WireRequest): Promise<WireResponse> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const received: Buffer[] = [];
    socket.on('connect', () => socket.write(encode(base, r)));
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const data = Buffer.concat(received);
      const head = parseHead(data);
      if (head) resolve({ status: head.status, headers: head.headers, body: body(r.method, head, data) });
      else reject(new Error(`${r.method} ${r.path}: connection closed before a response`));
    });
  });
}
