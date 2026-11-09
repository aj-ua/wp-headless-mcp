import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerFactory } from '../src/server.js';
import { TAXONOMIES, TYPES, testConfig } from './helpers.js';

const EDITOR = {
  id: 3,
  name: 'MCP Editor',
  roles: ['editor'],
  capabilities: { edit_posts: true, edit_pages: true, upload_files: true },
};

let authHeaders: (string | undefined)[];

/** Answers the startup requests createServerFactory makes, by URL path. */
function stubWordPress(namespaces: string[]): void {
  authHeaders = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL, init: RequestInit = {}) => {
      authHeaders.push((init.headers as Record<string, string> | undefined)?.Authorization);
      const path = new URL(String(input)).pathname;
      const body: Record<string, unknown> = {
        '/wp-json/': { name: 'AJ Digital Solutions', namespaces },
        '/wp-json/wp/v2/types': TYPES,
        '/wp-json/wp/v2/taxonomies': TAXONOMIES,
        '/wp-json/wp/v2/users/me': EDITOR,
      };
      const data = body[path];
      return Promise.resolve(
        new Response(JSON.stringify(data ?? { code: 'rest_no_route' }), {
          status: data ? 200 : 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

async function capabilities(env: Record<string, string>): Promise<{ tools: string[]; prompts: string[] }> {
  const createMcpServer = await createServerFactory(testConfig(env));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
  await client.close();
  return { tools, prompts };
}

const CREDENTIALS = { WP_USER: 'mcp-editor', WP_APP_PASSWORD: 'abcd efgh' };
const WRITE_TOOLS = ['create_draft', 'update_post', 'update_acf_fields', 'upload_media'];
const DEV_TOOLS = ['describe_content_model', 'generate_ts_types', 'sample_payload'];

beforeEach(() => {
  stubWordPress(['wp/v2', 'yoast/v1']);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('profiles', () => {
  it('public: read tools only, and never signs in even with credentials set', async () => {
    const { tools, prompts } = await capabilities({ MCP_PROFILE: 'public', ...CREDENTIALS });
    expect(tools).toEqual(expect.arrayContaining(['search_content', 'get_post', 'list_projects', 'get_project']));
    for (const tool of [...WRITE_TOOLS, ...DEV_TOOLS, 'content_audit', 'list_drafts']) {
      expect(tools).not.toContain(tool);
    }
    expect(prompts.sort()).toEqual(['answer_visitor_question', 'seo_review']);
    expect(authHeaders.every((header) => header === undefined)).toBe(true);
  });

  it('editor: adds draft-only editing tools and editor prompts, without menus for an Editor', async () => {
    const { tools, prompts } = await capabilities({ MCP_PROFILE: 'editor', ...CREDENTIALS });
    expect(tools).toEqual(expect.arrayContaining([...WRITE_TOOLS, 'content_audit', 'list_drafts']));
    expect(tools).not.toContain('get_menu');
    expect(prompts).toEqual(expect.arrayContaining(['write_blog_draft', 'weekly_content_report']));
  });

  it('dev: adds developer tools but no editing tools', async () => {
    const { tools } = await capabilities({ MCP_PROFILE: 'dev', ...CREDENTIALS });
    expect(tools).toEqual(expect.arrayContaining(DEV_TOOLS));
    for (const tool of WRITE_TOOLS) {
      expect(tools).not.toContain(tool);
    }
  });

  it('editor without credentials fails at startup', async () => {
    await expect(createServerFactory(testConfig({ MCP_PROFILE: 'editor' }))).rejects.toThrow(/needs WP_USER/);
  });
});

describe('optional tools', () => {
  it('leaves out SEO tools when Yoast is not installed', async () => {
    stubWordPress(['wp/v2']);
    const { tools, prompts } = await capabilities({});
    expect(tools).not.toContain('get_seo_meta');
    expect(prompts).not.toContain('seo_review');
  });

  it('names CPT tools from MCP_CPTS, or leaves them out', async () => {
    const custom = await capabilities({
      MCP_CPTS: '[{"postType":"project","singular":"work_item","plural":"portfolio"}]',
    });
    expect(custom.tools).toEqual(expect.arrayContaining(['list_portfolio', 'get_work_item']));
    const none = await capabilities({ MCP_CPTS: 'none' });
    expect(none.tools).not.toContain('list_projects');
  });
});
