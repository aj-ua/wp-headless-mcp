# Connecting a PWA backend

How a PWA's backend uses `wp-headless-mcp` over HTTP to give its users an AI assistant grounded in the WordPress site.

```
Browser (PWA)  ──►  PWA backend  ──►  Claude API
                        │                 │
                        │   (option A) Anthropic connects to the MCP server
                        │   (option B) the backend connects and runs the tools
                        ▼                 ▼
                    wp-headless-mcp (HTTP, MCP_PROFILE=public)  ──►  WordPress REST API
```

The browser never talks to the MCP server or Claude directly. The MCP token and the Anthropic API key stay on the backend.

## 1. Run the server in HTTP mode

```
MCP_TRANSPORT=http
MCP_PROFILE=public
MCP_HTTP_TOKEN=<output of: openssl rand -hex 32>
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3333
```

Start it from npm, with the settings above in the environment:

```
npx -y wp-headless-mcp
```

Or from a clone of the repository, where `npm start` reads them from `.env`:

```
npm run build
npm start
```

The endpoint is `POST /mcp`. `GET /health` returns `{"status":"ok"}` without a token, for load balancer checks.

| Setting                         | Default     | Notes                                                                                                                                  |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_TRANSPORT`                 | `stdio`     | `http` turns on the HTTP server                                                                                                        |
| `MCP_HTTP_TOKEN`                | required    | At least 32 characters. Clients send `Authorization: Bearer <token>`                                                                   |
| `MCP_HTTP_HOST`                 | `127.0.0.1` | Use `0.0.0.0` only behind a reverse proxy that terminates HTTPS                                                                        |
| `MCP_HTTP_PORT`                 | `3333`      |                                                                                                                                        |
| `MCP_HTTP_SESSIONS`             | `false`     | `false`: stateless, a fresh server per request (best for backends and serverless). `true`: one session per client via `Mcp-Session-Id` |
| `MCP_HTTP_SESSION_IDLE_MINUTES` | `30`        | Idle sessions are closed after this                                                                                                    |
| `MCP_HTTP_ALLOWED_ORIGINS`      | empty       | Comma-separated browser origins allowed to call the server (CORS). Leave empty for server-to-server use                                |

Always use `MCP_PROFILE=public` for a visitor-facing assistant. That profile never signs in to WordPress, so it can only read published content and has no editing tools.

### Security layers

1. **Host check:** when bound to a loopback address, requests must use a loopback `Host` header. This blocks DNS rebinding from web pages.
2. **Origin allowlist:** requests with an `Origin` header (browsers) are refused unless the origin is in `MCP_HTTP_ALLOWED_ORIGINS`.
3. **Bearer token:** compared in constant time. It is never written to the request log.
4. **Body limit:** 1 MB per request.

Keep the token on the server side. Putting it in PWA JavaScript would let anyone who opens the app call the MCP server directly.

## 2. Option A: Claude's MCP connector

Anthropic's servers connect to the MCP server for you, so the backend makes a single API call per turn. This needs the MCP server at a **public HTTPS URL** (deploy it behind a reverse proxy, or use a tunnel for testing). It can't reach `127.0.0.1` or `*.local` hosts.

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

export async function askSite(question: string): Promise<string> {
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    // Chat answers don't need deep reasoning; "low" keeps them fast and inexpensive.
    output_config: { effort: 'low' },
    betas: ['mcp-client-2025-11-20', 'server-side-fallback-2026-07-01'],
    // If a request is declined by safety classifiers, Anthropic re-runs it on a recommended fallback model.
    fallbacks: 'default',
    mcp_servers: [
      {
        type: 'url',
        url: process.env.MCP_SERVER_URL!, // the public https URL ending in /mcp
        name: 'wordpress',
        authorization_token: process.env.MCP_HTTP_TOKEN!,
      },
    ],
    tools: [
      {
        type: 'mcp_toolset',
        mcp_server_name: 'wordpress',
        // Allowlist: turn every tool off, then enable only what visitors need.
        default_config: { enabled: false },
        configs: {
          search_content: { enabled: true },
          get_post: { enabled: true },
          list_projects: { enabled: true },
          get_project: { enabled: true },
          get_company_info: { enabled: true },
        },
      },
    ],
    system:
      'You are the website assistant for this company. Answer only from the site content the tools return, ' +
      "cite the page URL for each fact, and say so when the site doesn't cover a question.",
    messages: [{ role: 'user', content: question }],
  });

  if (response.stop_reason === 'refusal') {
    return "Sorry, I can't help with that request.";
  }
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
```

Notes:

- `mcp_servers` and the `mcp_toolset` entry are required together, and the names must match.
- The tool names in `configs` come from the server's `tools/list`. The CPT tools (`list_projects`, `get_project`) are generated from the site's custom post types, so they differ per site.
- The connector uses stateless requests, which is the server's default mode.

## 3. Option B: the backend runs the MCP client

The backend connects to the MCP server with the MCP SDK and gives the site's tools to Claude through the SDK's tool runner. This works with a server on `127.0.0.1` (same machine or private network), so it suits local development against a `*.local` WordPress site. It also lets the backend log, filter, or rate-limit individual tool calls.

The Anthropic SDK's `mcpTool()` helper (`@anthropic-ai/sdk/helpers/beta/mcp`) turns each MCP tool into a runnable tool:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { mcpTool, type MCPCallToolResultLike, type MCPClientLike } from '@anthropic-ai/sdk/helpers/beta/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const VISITOR_TOOLS = new Set(['search_content', 'get_post', 'list_projects', 'get_project', 'get_company_info']);

export async function askSite(question: string): Promise<string> {
  const anthropic = new Anthropic();
  const mcp = new Client({ name: 'pwa-backend', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(process.env.MCP_SERVER_URL!), {
      requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_HTTP_TOKEN}` } },
    }),
  );

  // The MCP SDK's callTool() type also allows a legacy { toolResult } shape; mcpTool() needs { content }.
  const toolCaller: MCPClientLike = {
    callTool: async (params) => {
      const result = await mcp.callTool(params);
      if (!('content' in result)) {
        throw new Error(`MCP tool ${params.name} returned a legacy result without content.`);
      }
      return result as MCPCallToolResultLike;
    },
  };

  try {
    const { tools } = await mcp.listTools();
    const finalMessage = await anthropic.beta.messages.toolRunner({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: tools.filter((tool) => VISITOR_TOOLS.has(tool.name)).map((tool) => mcpTool(tool, toolCaller)),
      system:
        'You are the website assistant for this company. Answer only from the site content the tools return, ' +
        "cite the page URL for each fact, and say so when the site doesn't cover a question.",
      messages: [{ role: 'user', content: question }],
    });

    if (finalMessage.stop_reason === 'refusal') {
      return "Sorry, I can't help with that request.";
    }
    return finalMessage.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  } finally {
    await mcp.close();
  }
}
```

Notes:

- The backend needs `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk`.
- `MCP_SERVER_URL` can be `http://127.0.0.1:3333/mcp` here.
- For many requests per second, keep one MCP client connected instead of connecting per question.

## Runnable examples

Both options are in `examples/` and type-checked with `npm run typecheck:examples`. They read `ANTHROPIC_API_KEY`, `MCP_SERVER_URL`, and `MCP_HTTP_TOKEN` from the environment or `.env`.

```
# Option B: start the server in HTTP mode first (MCP_TRANSPORT=http, MCP_HTTP_TOKEN set), then:
npm run example:client -- "What kind of projects has this company built?"

# Option A: needs MCP_SERVER_URL set to the server's public https URL
npm run example:connector -- "How can I contact the company?"
```

`example:client` prints each tool call to stderr, for example `→ list_projects {"per_page":10}`.

## Choosing an option

|                         | Option A: MCP connector               | Option B: backend MCP client                         |
| ----------------------- | ------------------------------------- | ---------------------------------------------------- |
| MCP server location     | Public HTTPS URL                      | Anywhere the backend can reach, including localhost  |
| Code in the backend     | One API call                          | MCP client plus tool runner                          |
| Control over tool calls | Allowlist only                        | Full: log, filter, rate-limit, cache                 |
| Best for                | Production with a deployed MCP server | Local development, private networks, custom policies |

## Testing the server directly

```
curl -s http://127.0.0.1:3333/health

curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Authorization: Bearer $MCP_HTTP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_content","arguments":{"query":"acme"}}}'
```

The MCP Inspector can also connect over HTTP: choose "Streamable HTTP", enter the `/mcp` URL, and add the `Authorization` header.
