/**
 * PWA backend example, option A: Claude's MCP connector. Anthropic's servers connect
 * to the MCP server, so the backend makes one API call per question.
 *
 * Needs the MCP server at a public HTTPS URL (MCP_SERVER_URL, ending in /mcp);
 * 127.0.0.1 and *.local hosts are not reachable from Anthropic. Also ANTHROPIC_API_KEY
 * and MCP_HTTP_TOKEN.
 *
 *   npm run example:connector -- "How can I contact the company?"
 */
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT =
  'You are the website assistant for this company. Answer only from the site content the tools return, ' +
  "cite the page URL for each fact, and say so when the site doesn't cover a question.";

export async function askSite(question: string): Promise<string> {
  const serverUrl = process.env.MCP_SERVER_URL;
  if (!serverUrl?.startsWith('https://')) {
    throw new Error('MCP_SERVER_URL must be a public https:// URL for the MCP connector.');
  }

  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'low' },
    betas: ['mcp-client-2025-11-20', 'server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    mcp_servers: [
      {
        type: 'url',
        url: serverUrl,
        name: 'wordpress',
        authorization_token: process.env.MCP_HTTP_TOKEN ?? null,
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
    system: SYSTEM_PROMPT,
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

const question = process.argv.slice(2).join(' ') || 'How can I contact the company?';
askSite(question)
  .then((answer) => process.stdout.write(`${answer}\n`))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
