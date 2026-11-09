import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { HttpConfig } from './config.js';
import type { ServerFactory } from './server.js';

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const CORS_ALLOW_HEADERS = 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id';
const CORS_EXPOSE_HEADERS = 'mcp-session-id, mcp-protocol-version';

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly close: () => Promise<void>;
  lastSeen: number;
}

export interface HttpServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Compares secrets in constant time; hashing first makes both sides the same length. */
function safeEqual(a: string, b: string): boolean {
  const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  // -32000 is the generic server error code used by MCP transports.
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body is larger than 1 MB.');
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

/** Host name from the Host header, without the port ("[::1]:3333" → "::1"). */
function hostName(header: string | undefined): string {
  if (!header) {
    return '';
  }
  const bracketed = header.match(/^\[([^\]]+)\]/);
  return (bracketed?.[1] ?? header.split(':')[0] ?? '').toLowerCase();
}

/**
 * Streamable HTTP server for remote MCP clients such as a PWA backend.
 * Security layers, in order: Host check (when bound to loopback), Origin allowlist,
 * bearer token, and a body size limit.
 */
export async function startHttpServer(http: HttpConfig, createMcpServer: ServerFactory): Promise<HttpServerHandle> {
  const sessions = new Map<string, Session>();
  const boundToLoopback = LOOPBACK_HOSTS.has(http.host);

  /**
   * Blocks DNS rebinding: a web page on another domain resolving to 127.0.0.1
   * would send its own Host header, which isn't a loopback name.
   * When bound to a public interface (behind a reverse proxy), the proxy owns this check.
   */
  function checkHost(req: IncomingMessage): void {
    if (boundToLoopback && !LOOPBACK_HOSTS.has(hostName(req.headers.host))) {
      throw new HttpError(403, 'Host not allowed.');
    }
  }

  /** Browsers send Origin; only listed origins may call. Server-to-server requests have none. */
  function corsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin) {
      return {};
    }
    if (!http.allowedOrigins.includes(origin)) {
      throw new HttpError(403, `Origin ${origin} is not allowed. Add it to MCP_HTTP_ALLOWED_ORIGINS.`);
    }
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
      Vary: 'Origin',
    };
  }

  function checkToken(req: IncomingMessage): void {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !safeEqual(token, http.token)) {
      throw new HttpError(401, 'Missing or invalid bearer token.', {
        'WWW-Authenticate': 'Bearer realm="wp-headless-mcp"',
      });
    }
  }

  /** Stateless: a fresh server and transport per request, closed when the response ends. */
  async function handleStateless(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'This server is stateless: only POST is supported.', { Allow: 'POST, OPTIONS' });
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** Sessions: one server per Mcp-Session-Id, created by an initialize request. */
  async function handleSession(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new HttpError(404, 'Session not found or expired. Send a new initialize request.');
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      throw new HttpError(400, 'Missing Mcp-Session-Id header. Start with an initialize request.');
    }

    const server = createMcpServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          transport,
          lastSeen: Date.now(),
          close: async () => {
            await transport.close();
            await server.close();
          },
        });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    checkHost(req);

    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sessions: http.sessions ? sessions.size : undefined }));
      return;
    }
    if (path !== MCP_PATH) {
      throw new HttpError(404, `Not found. The MCP endpoint is ${MCP_PATH}.`);
    }

    const cors = corsHeaders(req);
    for (const [name, value] of Object.entries(cors)) {
      res.setHeader(name, value);
    }

    // CORS preflight: no token needed, browsers never send it here.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': http.sessions ? 'GET, POST, DELETE, OPTIONS' : 'POST, OPTIONS',
        'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    checkToken(req);
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    await (http.sessions ? handleSession(req, res, body) : handleStateless(req, res, body));
  }

  const server: Server = createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      // One line per request; never logs headers, so the token stays out of logs.
      console.error(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    });

    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJsonRpcError(res, error.status, error.message, error.headers);
        return;
      }
      console.error('Unhandled HTTP error:', error);
      sendJsonRpcError(res, 500, 'Internal server error.');
    });
  });

  // Closes sessions that have been idle too long.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - http.sessionIdleMinutes * 60_000;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        void session.close();
      }
    }
  }, 60_000);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(http.port, http.host, () => resolve());
  });

  const displayHost = http.host.includes(':') ? `[${http.host}]` : http.host;
  // Port 0 asks the OS for a free port (used by tests); report the one actually bound.
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : http.port;
  return {
    url: `http://${displayHost}:${port}${MCP_PATH}`,
    close: async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map((session) => session.close()));
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
