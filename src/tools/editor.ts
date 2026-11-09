import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AcfSchema } from '../wp/acf-schema.js';
import type { WpClient } from '../wp/client.js';
import { decodeEntities } from '../wp/format.js';
import { downloadForUpload } from '../wp/media.js';
import type { EditablePost, PostService } from '../wp/posts.js';
import type { SiteModel } from '../wp/site-model.js';
import type { WpPost } from '../wp/types.js';
import { jsonResult, toolError } from './result.js';

/** Statuses the editor tools may change. Anything else (publish, future, private) is live or scheduled. */
const EDITABLE_STATUSES = new Set(['draft', 'pending', 'auto-draft']);

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

interface SavedPost {
  readonly id: number;
  readonly type: string;
  readonly status: string;
  readonly link: string;
  readonly title: { readonly raw?: string; readonly rendered: string };
}

interface WpMedia {
  readonly id: number;
  readonly source_url: string;
  readonly alt_text: string;
  readonly media_type: string;
  readonly mime_type: string;
}

const termsInput = z
  .record(z.string(), z.array(z.string()))
  .optional()
  .describe('Terms by taxonomy slug, e.g. {"category": ["news"], "post_tag": ["gsap"]}. Replaces existing terms.');

/** Where to review an item in wp-admin. */
function editUrl(siteUrl: string, id: number): string {
  return `${siteUrl}/wp-admin/post.php?post=${id}&action=edit`;
}

function savedResult(siteUrl: string, post: SavedPost, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: post.id,
    type: post.type,
    status: post.status,
    title: decodeEntities(post.title.raw ?? post.title.rendered),
    preview_url: `${siteUrl}/?p=${post.id}&preview=true`,
    edit_url: editUrl(siteUrl, post.id),
    ...extra,
  };
}

function assertEditable(post: EditablePost): void {
  if (!EDITABLE_STATUSES.has(post.status)) {
    throw new Error(
      `${post.type} ${post.id} is "${post.status}", so it is live or scheduled and can't be changed here. ` +
        `Use create_draft with copy_from: ${post.id} to make a draft copy for review.`,
    );
  }
}

/** Checks ACF field names against the field groups that apply to the item. */
async function validateAcfFields(
  acfSchema: AcfSchema,
  target: { postType: string; postId: number; template: string },
  fields: Record<string, unknown>,
): Promise<void> {
  const schema = await acfSchema.forPost(target);
  const known = new Set(schema.groups.flatMap((group) => group.fields.map((field) => field.name)));
  const unknown = Object.keys(fields).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown ACF field(s) for ${target.postType}: ${unknown.join(', ')}. ` +
        (known.size > 0 ? `Known fields: ${[...known].join(', ')}.` : 'No ACF field groups apply to this item.'),
    );
  }
  const hidden = schema.groups.filter((group) => !group.showInRest);
  if (hidden.length > 0) {
    throw new Error(
      `Field group(s) ${hidden.map((g) => `"${g.title}"`).join(', ')} have "Show in REST API" off, so their fields can't be saved.`,
    );
  }
}

export function registerEditorTools(
  server: McpServer,
  wp: WpClient,
  site: SiteModel,
  posts: PostService,
  acfSchema: AcfSchema,
): void {
  const siteUrl = wp.siteUrl;

  server.registerTool(
    'create_draft',
    {
      title: 'Create a draft',
      description:
        'Creates a new draft post, page, or custom post. It is never published: an editor reviews it in wp-admin. ' +
        'Use copy_from to start from an existing (for example published) item, then override any field. ' +
        'Returns preview and edit links.',
      inputSchema: {
        post_type: z.string().default('post').describe('Post type slug, e.g. "post", "page", "project"'),
        copy_from: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'ID of an item of the same post type to copy (title, content, excerpt, template, image, terms, ACF)',
          ),
        title: z.string().min(1).optional().describe('Title. Required unless copy_from is set.'),
        content_html: z.string().optional().describe('Body as HTML (the site uses the Classic Editor)'),
        excerpt: z.string().optional(),
        slug: z.string().optional(),
        template: z.string().optional().describe('Page template file, e.g. "page-templates/home.php"'),
        featured_media: z.number().int().nonnegative().optional().describe('Media ID for the featured image'),
        terms: termsInput,
        acf: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('ACF field values by field name. Images and related posts take IDs.'),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    async (input) => {
      try {
        const source = input.copy_from ? await posts.getForEdit(input.post_type, input.copy_from) : undefined;
        const title = input.title ?? (source ? `${source.title} (draft copy)` : undefined);
        if (!title) {
          throw new Error('Provide a title, or copy_from to copy one.');
        }

        const template = input.template ?? source?.template ?? '';
        const acf = { ...(source?.acf ?? {}), ...(input.acf ?? {}) };
        if (input.acf && Object.keys(input.acf).length > 0) {
          await validateAcfFields(acfSchema, { postType: input.post_type, postId: 0, template }, input.acf);
        }

        const body: Record<string, unknown> = {
          status: 'draft',
          title,
          content: input.content_html ?? source?.content ?? '',
          excerpt: input.excerpt ?? source?.excerpt ?? '',
          ...(input.slug ? { slug: input.slug } : {}),
          ...(template ? { template } : {}),
          ...((input.featured_media ?? source?.featuredMedia)
            ? { featured_media: input.featured_media ?? source?.featuredMedia }
            : {}),
          ...(source?.terms ?? {}),
          ...(input.terms ? await posts.termFields(input.terms) : {}),
          ...(Object.keys(acf).length > 0 ? { acf } : {}),
        };

        const route = await site.postTypeRoute(input.post_type);
        const saved = (await wp.post<SavedPost>(route, body)).data;
        return jsonResult(
          savedResult(siteUrl, saved, source ? { copied_from: { id: source.id, url: source.link } } : {}),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'update_post',
    {
      title: 'Update a draft',
      description:
        'Updates a draft or pending item: title, HTML content, excerpt, slug, template, featured image, terms, ' +
        'or status (draft ↔ pending review). Published or scheduled items are refused; copy them with create_draft first.',
      inputSchema: {
        post_type: z.string().default('post'),
        id: z.number().int().positive(),
        title: z.string().min(1).optional(),
        content_html: z.string().optional(),
        excerpt: z.string().optional(),
        slug: z.string().optional(),
        template: z.string().optional(),
        featured_media: z.number().int().nonnegative().optional(),
        terms: termsInput,
        status: z.enum(['draft', 'pending']).optional().describe('"pending" submits it for review; it never publishes'),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (input) => {
      try {
        const current = await posts.getForEdit(input.post_type, input.id);
        assertEditable(current);

        const body: Record<string, unknown> = {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.content_html !== undefined ? { content: input.content_html } : {}),
          ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.template !== undefined ? { template: input.template } : {}),
          ...(input.featured_media !== undefined ? { featured_media: input.featured_media } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.terms ? await posts.termFields(input.terms) : {}),
        };
        if (Object.keys(body).length === 0) {
          throw new Error('Nothing to update: pass at least one field.');
        }

        const route = await site.postTypeRoute(input.post_type);
        const saved = (await wp.post<SavedPost>(`${route}/${input.id}`, body)).data;
        return jsonResult(savedResult(siteUrl, saved, { updated_fields: Object.keys(body) }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'update_acf_fields',
    {
      title: 'Update ACF fields on a draft',
      description:
        'Sets ACF custom field values on a draft or pending item. Field names are checked against its field groups ' +
        '(see get_acf_fields). Images and related posts take IDs; repeaters take an array of row objects. ' +
        'Only the given fields change.',
      inputSchema: {
        post_type: z.string().default('page'),
        id: z.number().int().positive(),
        fields: z.record(z.string(), z.unknown()).describe('Field values by field name'),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ post_type, id, fields }) => {
      try {
        if (Object.keys(fields).length === 0) {
          throw new Error('Pass at least one field.');
        }
        const current = await posts.getForEdit(post_type, id);
        assertEditable(current);
        await validateAcfFields(acfSchema, { postType: current.type, postId: id, template: current.template }, fields);

        const route = await site.postTypeRoute(post_type);
        const saved = (await wp.post<SavedPost>(`${route}/${id}`, { acf: fields })).data;
        return jsonResult(savedResult(siteUrl, saved, { updated_fields: Object.keys(fields) }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_drafts',
    {
      title: 'List drafts and pending items',
      description: 'Lists unpublished items (drafts and items pending review) of one post type, newest change first.',
      inputSchema: {
        post_type: z.string().default('post'),
        per_page: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ post_type, per_page, page }) => {
      try {
        const route = await site.postTypeRoute(post_type);
        const res = await wp.get<WpPost[]>(route, {
          status: 'draft,pending',
          orderby: 'modified',
          order: 'desc',
          per_page,
          page,
          _fields: 'id,type,status,modified,title',
        });
        return jsonResult({
          post_type,
          total: res.total ?? res.data.length,
          page,
          items: res.data.map((post) => ({
            id: post.id,
            status: post.status,
            title: decodeEntities(post.title.rendered) || '(no title)',
            modified: post.modified,
            edit_url: editUrl(siteUrl, post.id),
          })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'upload_media',
    {
      title: 'Upload an image or PDF',
      description:
        'Downloads a file from a public URL and adds it to the media library with alt text and caption. ' +
        'Accepts JPEG, PNG, GIF, WebP, AVIF, and PDF up to 10 MB. Returns the media ID for featured_media or ACF image fields.',
      inputSchema: {
        url: z.string().url().describe('Public http(s) URL of the file'),
        alt_text: z.string().describe('Alt text describing the image, for accessibility and SEO'),
        caption: z.string().optional(),
        title: z.string().optional(),
        filename: z.string().optional().describe('File name to store, without path'),
        attach_to: z.number().int().positive().optional().describe('ID of a draft to attach the file to'),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    async ({ url, alt_text, caption, title, filename, attach_to }) => {
      try {
        const file = await downloadForUpload(url, filename);
        const uploaded = (await wp.upload<WpMedia>(file.bytes, file.filename, file.contentType)).data;
        const media = (
          await wp.post<WpMedia>(`wp/v2/media/${uploaded.id}`, {
            alt_text,
            ...(caption ? { caption } : {}),
            ...(title ? { title } : {}),
            ...(attach_to ? { post: attach_to } : {}),
          })
        ).data;

        return jsonResult({
          id: media.id,
          url: media.source_url,
          alt_text: media.alt_text,
          mime_type: media.mime_type,
          edit_url: editUrl(siteUrl, media.id),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
