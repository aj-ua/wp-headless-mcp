import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { PostService } from '../wp/posts.js';
import type { SiteModel } from '../wp/site-model.js';

/** How many recent items per post type to advertise in resource listings. */
const LIST_LIMIT = 20;
const RESOURCE_MAX_CHARS = 20000;

function variable(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Renders a post detail as a Markdown document, which reads better as context than JSON. */
function toMarkdown(detail: Record<string, unknown>): string {
  const { title, url, content, acf, acf_note, featured_image, terms, ...meta } = detail;
  const lines = [`# ${String(title)}`, '', `URL: ${String(url)}`];

  for (const [key, value] of Object.entries(meta)) {
    const printable = typeof value === 'string' || typeof value === 'number';
    if (['id', 'slug', 'type', 'date', 'modified', 'author', 'template'].includes(key) && printable) {
      lines.push(`${key}: ${value}`);
    }
  }
  if (featured_image) {
    lines.push(`featured_image: ${(featured_image as { url: string }).url}`);
  }
  if (terms) {
    lines.push(`terms: ${JSON.stringify(terms)}`);
  }

  if (typeof content === 'string' && content !== '') {
    lines.push('', '## Content', '', content);
  }
  if (acf) {
    lines.push('', '## Custom fields (ACF)', '', '```json', JSON.stringify(acf, null, 2), '```');
  } else if (typeof acf_note === 'string') {
    lines.push('', `_${acf_note}_`);
  }

  return lines.join('\n');
}

async function readAsMarkdown(
  uri: URL,
  posts: PostService,
  postType: string,
  lookup: { id?: number; slug?: string },
): Promise<ReadResourceResult> {
  const detail = await posts.get({ postType, ...lookup, includeAcf: true, maxChars: RESOURCE_MAX_CHARS });
  return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: toMarkdown(detail) }] };
}

export function registerContentResources(server: McpServer, site: SiteModel, posts: PostService): void {
  server.registerResource(
    'post',
    new ResourceTemplate('wp://post/{type}/{id}', {
      list: async () => {
        const types = (await site.postTypes()).filter((type) => type.slug !== 'page');
        const lists = await Promise.all(
          types.map((type) =>
            posts.list({
              postType: type.slug,
              orderby: 'date',
              order: 'desc',
              includeAcf: false,
              perPage: LIST_LIMIT,
              page: 1,
            }),
          ),
        );
        return {
          resources: lists.flatMap((list) =>
            list.items.map((item) => ({
              uri: `wp://post/${item.type}/${item.id}`,
              name: item.title,
              title: item.title,
              description: `${item.type} · ${item.url}`,
              mimeType: 'text/markdown',
            })),
          ),
        };
      },
      complete: {
        type: async (value) =>
          (await site.postTypes()).map((type) => type.slug).filter((slug) => slug.startsWith(value)),
      },
    }),
    {
      title: 'Post, page, or custom post by type and ID',
      description: 'One published item as Markdown, including ACF fields. Example: wp://post/project/310',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const id = Number(variable(variables.id));
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`Invalid post ID in ${uri.href}.`);
      }
      return readAsMarkdown(uri, posts, variable(variables.type), { id });
    },
  );

  server.registerResource(
    'page',
    new ResourceTemplate('wp://page/{slug}', {
      list: async () => {
        const list = await posts.list({
          postType: 'page',
          orderby: 'menu_order',
          order: 'asc',
          includeAcf: false,
          perPage: 50,
          page: 1,
        });
        return {
          resources: list.items.map((item) => ({
            uri: `wp://page/${item.slug}`,
            name: item.title,
            title: item.title,
            description: item.url,
            mimeType: 'text/markdown',
          })),
        };
      },
    }),
    {
      title: 'Page by slug',
      description: 'One published page as Markdown, including ACF fields. Example: wp://page/home',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => readAsMarkdown(uri, posts, 'page', { slug: variable(variables.slug) }),
  );
}
