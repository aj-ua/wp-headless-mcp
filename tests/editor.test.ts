import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerEditorTools } from '../src/tools/editor.js';
import { AcfSchema } from '../src/wp/acf-schema.js';
import type { WpClient } from '../src/wp/client.js';
import { PostService } from '../src/wp/posts.js';
import { SiteModel } from '../src/wp/site-model.js';
import { ACF_JSON_DIR, fakeWp } from './helpers.js';

interface Write {
  route: string;
  body: Record<string, unknown>;
}

/** Items as WordPress returns them in edit context. */
const ITEMS: Record<string, Record<string, unknown>> = {
  'wp/v2/project/310': {
    id: 310,
    type: 'project',
    status: 'publish',
    link: 'http://aj-ua.local/project/acme/',
    slug: 'acme',
    title: { raw: 'Acme' },
    content: { raw: '' },
    excerpt: { raw: '' },
    template: '',
    featured_media: 311,
    acf: { subtitle: 'Company website', url: 'https://acme.test', info: '<p>Info</p>', images: [] },
  },
  'wp/v2/project/324': {
    id: 324,
    type: 'project',
    status: 'draft',
    link: 'http://aj-ua.local/?post_type=project&p=324',
    slug: '',
    title: { raw: 'Acme (draft copy)' },
    content: { raw: '' },
    excerpt: { raw: '' },
    template: '',
    featured_media: 311,
    acf: { subtitle: 'Company website' },
  },
};

let writes: Write[];
let client: Client;

async function connect(): Promise<Client> {
  const { wp } = fakeWp(ITEMS);
  writes = [];
  const writer = Object.assign(Object.create(Object.getPrototypeOf(wp) as object) as object, wp, {
    post: (route: string, body: Record<string, unknown>) => {
      writes.push({ route, body });
      return Promise.resolve({
        data: {
          id: 999,
          type: 'project',
          status: body.status ?? 'draft',
          link: '',
          title: { raw: body.title ?? 'x', rendered: '' },
        },
        total: undefined,
        totalPages: undefined,
      });
    },
  }) as WpClient;

  const site = new SiteModel(writer);
  const server = new McpServer({ name: 'test', version: '0' });
  registerEditorTools(server, writer, site, new PostService(writer, site), new AcfSchema(writer, site, ACF_JSON_DIR));

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientSide);
  return mcp;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? '';
  return { isError: result.isError === true, text };
}

beforeEach(async () => {
  client = await connect();
});

describe('editor tools never touch published content', () => {
  it('refuses to update a published item and suggests a draft copy', async () => {
    const result = await call('update_post', { post_type: 'project', id: 310, title: 'Changed' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('copy_from: 310');
    expect(writes).toEqual([]);
  });

  it('refuses ACF changes on a published item', async () => {
    const result = await call('update_acf_fields', { post_type: 'project', id: 310, fields: { subtitle: 'x' } });
    expect(result.isError).toBe(true);
    expect(writes).toEqual([]);
  });

  it('rejects publish as a status before anything is sent', async () => {
    const result = await call('update_post', { post_type: 'project', id: 324, status: 'publish' });
    expect(result.isError).toBe(true);
    expect(writes).toEqual([]);
  });
});

describe('create_draft', () => {
  it('always saves as a draft', async () => {
    await call('create_draft', { post_type: 'project', title: 'New project', content_html: '<p>Body</p>' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ route: 'wp/v2/project', body: { status: 'draft', title: 'New project' } });
  });

  it('copies a published item, including ACF, and lets given fields override', async () => {
    const result = await call('create_draft', { post_type: 'project', copy_from: 310, acf: { subtitle: 'Updated' } });
    expect(result.isError).toBe(false);
    expect(writes[0]!.body).toMatchObject({
      status: 'draft',
      title: 'Acme (draft copy)',
      featured_media: 311,
      acf: { subtitle: 'Updated', url: 'https://acme.test' },
    });
    expect(JSON.parse(result.text).copied_from).toEqual({ id: 310, url: 'http://aj-ua.local/project/acme/' });
  });

  it('rejects unknown ACF fields and lists the valid ones', async () => {
    const result = await call('create_draft', { post_type: 'project', title: 'x', acf: { not_a_field: 1 } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Known fields: subtitle, url, info, images');
    expect(writes).toEqual([]);
  });
});

describe('drafts can be edited', () => {
  it('updates a draft and moves it to pending review', async () => {
    const result = await call('update_post', { post_type: 'project', id: 324, status: 'pending', title: 'Ready' });
    expect(result.isError).toBe(false);
    expect(writes[0]).toEqual({ route: 'wp/v2/project/324', body: { title: 'Ready', status: 'pending' } });
  });

  it('updates ACF fields on a draft', async () => {
    await call('update_acf_fields', { post_type: 'project', id: 324, fields: { subtitle: 'New subtitle' } });
    expect(writes[0]).toEqual({ route: 'wp/v2/project/324', body: { acf: { subtitle: 'New subtitle' } } });
  });
});
