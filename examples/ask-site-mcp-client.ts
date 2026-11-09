/**
 * PWA backend example, option B: the backend runs the MCP client and gives the
 * site's tools to Claude through the SDK tool runner. Works against a local server.
 *
 * Needs: the MCP server running in HTTP mode, plus ANTHROPIC_API_KEY,
 * MCP_SERVER_URL (default http://127.0.0.1:3333/mcp), and MCP_HTTP_TOKEN.
 *
 *   npm run example:client -- "What kind of projects has this company built?"
 */
import Anthropic from '@anthropic-ai/sdk';
import { mcpTool, type MCPCallToolResultLike, type MCPClientLike } from '@anthropic-ai/sdk/helpers/beta/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Read-only tools a website visitor's assistant needs. */
const VISITOR_TOOLS = new Set(['search_content', 'get_post', 'list_projects', 'get_project', 'get_company_info']);

const SYSTEM_PROMPT =
  'You are the website assistant for this company. Answer only from the site content the tools return, ' +
  "cite the page URL for each fact, and say so when the site doesn't cover a question.";

export async function askSite(question: string): Promise<string> {
  const anthropic = new Anthropic();
  const mcp = new Client({ name: 'pwa-backend', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:3333/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_HTTP_TOKEN ?? ''}` } },
    }),
  );

  // callTool() can also return the legacy { toolResult } shape; current servers
  // (including this one) always send { content }, which is what mcpTool() expects.
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
    const runner = anthropic.beta.messages.toolRunner({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      // Chat answers don't need deep reasoning; "low" keeps them fast and inexpensive.
      output_config: { effort: 'low' },
      // If safety classifiers decline a request, Anthropic re-runs it on a recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: tools.filter((tool) => VISITOR_TOOLS.has(tool.name)).map((tool) => mcpTool(tool, toolCaller)),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
    });

    // Log each tool call so the run is easy to follow.
    for await (const message of runner) {
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          console.error(`→ ${block.name} ${JSON.stringify(block.input)}`);
        }
      }
    }
    const finalMessage = await runner.done();

    if (finalMessage.stop_reason === 'refusal') {
      return "Sorry, I can't help with that request.";
    }
    const usage = finalMessage.usage;
    console.error(
      `(stop: ${finalMessage.stop_reason}, last turn tokens in/out: ${usage.input_tokens}/${usage.output_tokens})`,
    );
    return finalMessage.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  } finally {
    await mcp.close();
  }
}

const question = process.argv.slice(2).join(' ') || 'What kind of projects has this company built?';
askSite(question)
  .then((answer) => process.stdout.write(`${answer}\n`))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
