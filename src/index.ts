#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { startHttpServer } from './http.js';
import { createServerFactory } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const createMcpServer = await createServerFactory(config);

  // stdout is reserved for the MCP protocol in stdio mode, so diagnostics always go to stderr.
  if (config.transport === 'http' && config.http) {
    const handle = await startHttpServer(config.http, createMcpServer);
    console.error(
      `wp-headless-mcp listening on ${handle.url} ` +
        `(profile: ${config.profile}, ${config.http.sessions ? 'sessions' : 'stateless'}, site: ${config.wpUrl})`,
    );

    const shutdown = (): void => {
      void handle.close().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  await createMcpServer().connect(new StdioServerTransport());
  console.error(`wp-headless-mcp running on stdio (profile: ${config.profile}, site: ${config.wpUrl})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
