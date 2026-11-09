import { request } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpConfig } from '../src/config.js';
import { startHttpServer, type HttpServerHandle } from '../src/http.js';

const TOKEN = 'test-token-'.padEnd(40, 'x');
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

/** A tiny MCP server with one tool, so the transport can be tested without WordPress. */
function fakeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0' });
  server.registerTool('ping', { description: 'Replies pong' }, () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** node:http request, which (unlike fetch) lets tests send any Host or Origin header. */
function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'POST', headers: options.headers }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const mcpHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${TOKEN}`,
  ...extra,
});

function config(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    allowedOrigins: ['http://localhost:5173'],
    sessions: false,
    sessionIdleMinutes: 30,
    ...overrides,
  };
}

describe('HTTP transport, stateless', () => {
  let handle: HttpServerHandle;
  let url: string;

  beforeAll(async () => {
    handle = await startHttpServer(config(), fakeServer);
    url = handle.url;
  });
  afterAll(() => handle.close());

  it('serves /health without a token', async () => {
    const res = await send(url.replace('/mcp', '/health'), { method: 'GET' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it.each([
    ['no token', {}],
    ['a wrong token', { Authorization: 'Bearer wrong' }],
  ])('rejects %s with 401', async (_label, headers) => {
    const res = await send(url, {
      headers: { ...mcpHeaders(), Authorization: '', ...headers },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('answers initialize and tool calls with a valid token', async () => {
    const init = await send(url, { headers: mcpHeaders(), body: JSON.stringify(INIT) });
    expect(init.status).toBe(200);
    expect(JSON.parse(init.body).result.serverInfo.name).toBe('test');

    const call = await send(url, {
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } }),
    });
    expect(JSON.parse(call.body).result.content[0].text).toBe('pong');
  });

  it('blocks a foreign Host header (DNS rebinding)', async () => {
    const res = await send(url, { headers: mcpHeaders({ Host: 'attacker.test' }), body: JSON.stringify(INIT) });
    expect(res.status).toBe(403);
  });

  it('blocks origins that are not allowed, and answers CORS preflight for allowed ones', async () => {
    const blocked = await send(url, {
      headers: mcpHeaders({ Origin: 'http://attacker.test' }),
      body: JSON.stringify(INIT),
    });
    expect(blocked.status).toBe(403);

    const preflight = await send(url, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('rejects GET, unknown paths, invalid JSON, and bodies over 1 MB', async () => {
    expect((await send(url, { method: 'GET', headers: mcpHeaders() })).status).toBe(405);
    expect((await send(url.replace('/mcp', '/other'), { headers: mcpHeaders(), body: '{}' })).status).toBe(404);
    expect((await send(url, { headers: mcpHeaders(), body: '{nope' })).status).toBe(400);
    expect((await send(url, { headers: mcpHeaders(), body: 'a'.repeat(1024 * 1024 + 10) })).status).toBe(413);
  });
});

describe('HTTP transport, sessions', () => {
  let handle: HttpServerHandle;

  beforeAll(async () => {
    handle = await startHttpServer(config({ sessions: true }), fakeServer);
  });
  afterAll(() => handle.close());

  it('issues a session ID on initialize and requires it afterwards', async () => {
    const init = await send(handle.url, { headers: mcpHeaders(), body: JSON.stringify(INIT) });
    const sessionId = init.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    const missing = await send(handle.url, {
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(missing.status).toBe(400);

    const unknown = await send(handle.url, {
      headers: mcpHeaders({ 'Mcp-Session-Id': '00000000-0000-0000-0000-000000000000' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(unknown.status).toBe(404);

    const health = await send(handle.url.replace('/mcp', '/health'), { method: 'GET' });
    expect(JSON.parse(health.body)).toEqual({ status: 'ok', sessions: 1 });
  });
});
