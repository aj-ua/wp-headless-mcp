import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WpClient } from '../wp/client.js';
import { decodeEntities } from '../wp/format.js';
import type { SiteFeatures } from '../wp/features.js';
import type { YoastHeadJson } from '../wp/seo.js';
import type { SiteModel } from '../wp/site-model.js';
import type { WpEmbeddedMedia } from '../wp/types.js';
import { jsonResult, toolError } from './result.js';

interface AuditPost {
  readonly id: number;
  readonly type: string;
  readonly status: string;
  readonly link: string;
  readonly modified: string;
  readonly title: { readonly rendered: string };
  readonly excerpt?: { readonly raw?: string };
  readonly featured_media?: number;
  readonly acf?: Record<string, unknown> | unknown[];
  readonly yoast_head_json?: YoastHeadJson;
  readonly _embedded?: { readonly 'wp:featuredmedia'?: WpEmbeddedMedia[] };
}

interface WpMenu {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly locations: string[];
}

interface WpMenuItem {
  readonly id: number;
  readonly title: { readonly rendered: string };
  readonly url: string;
  readonly parent: number;
  readonly menu_order: number;
  readonly object: string;
  readonly object_id: number;
}

interface MenuNode {
  title: string;
  url: string;
  children: MenuNode[];
}

const PAGE_SIZE = 100;

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  missing_featured_image: 'No featured image. It is also the default social sharing image.',
  missing_featured_image_alt: 'The featured image has no alt text.',
  acf_images_missing_alt: 'Images in ACF fields have no alt text (count per item in details).',
  missing_excerpt: 'No hand-written excerpt; WordPress generates one from the content.',
  missing_meta_description: 'No Yoast meta description.',
  stale: 'Not modified within the stale_months window.',
};

/** Counts ACF image values (acf_format=standard) that have no alt text, at any depth. */
function countImagesWithoutAlt(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum: number, item) => sum + countImagesWithoutAlt(item), 0);
  }
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  const obj = value as Record<string, unknown>;
  if ('url' in obj && 'mime_type' in obj && String(obj.mime_type).startsWith('image/')) {
    return typeof obj.alt === 'string' && obj.alt.trim() !== '' ? 0 : 1;
  }
  return Object.values(obj).reduce((sum: number, inner) => sum + countImagesWithoutAlt(inner), 0);
}

function buildMenuTree(items: WpMenuItem[]): MenuNode[] {
  const nodes = new Map<number, MenuNode>();
  const sorted = [...items].sort((a, b) => a.menu_order - b.menu_order);
  for (const item of sorted) {
    nodes.set(item.id, { title: decodeEntities(item.title.rendered), url: item.url, children: [] });
  }
  const roots: MenuNode[] = [];
  for (const item of sorted) {
    const node = nodes.get(item.id);
    const parent = item.parent ? nodes.get(item.parent) : undefined;
    if (node) {
      (parent ? parent.children : roots).push(node);
    }
  }
  return roots;
}

export function registerAuditTools(server: McpServer, wp: WpClient, site: SiteModel, features: SiteFeatures): void {
  server.registerTool(
    'content_audit',
    {
      title: 'Audit content quality',
      description:
        'Scans items and lists content problems: missing featured image, missing alt text (featured and ACF images), ' +
        'missing excerpt (posts only), missing Yoast meta description, and content not updated in a while. ' +
        'Returns counts per problem and the affected items.',
      inputSchema: {
        post_type: z.string().optional().describe('Post type slug to audit. Omit to audit every content type.'),
        stale_months: z
          .number()
          .int()
          .min(1)
          .max(120)
          .default(24)
          .describe('Flag items not modified for this many months'),
        include_drafts: z.boolean().default(false).describe('Also audit drafts and items pending review'),
        page: z.number().int().min(1).default(1).describe('Page of 100 items per post type'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ post_type, stale_months, include_drafts, page }) => {
      try {
        const types = post_type ? [post_type] : (await site.postTypes()).map((type) => type.slug);
        const staleBefore = new Date();
        staleBefore.setMonth(staleBefore.getMonth() - stale_months);

        const counts: Record<string, number> = {};
        const scanned: Record<string, { scanned: number; total: number }> = {};
        const items: Record<string, unknown>[] = [];

        for (const type of types) {
          const route = await site.postTypeRoute(type);
          const res = await wp.get<AuditPost[]>(route, {
            context: 'edit',
            status: include_drafts ? 'publish,draft,pending' : 'publish',
            per_page: PAGE_SIZE,
            page,
            _embed: 'wp:featuredmedia',
            acf_format: 'standard',
            _fields: 'id,type,status,link,modified,title,excerpt,featured_media,acf,yoast_head_json,_links,_embedded',
          });
          scanned[type] = { scanned: res.data.length, total: res.total ?? res.data.length };

          for (const post of res.data) {
            const issues: string[] = [];
            const details: Record<string, unknown> = {};
            const media = post._embedded?.['wp:featuredmedia']?.[0];

            if (!post.featured_media) {
              issues.push('missing_featured_image');
            } else if (media && !media.alt_text?.trim()) {
              issues.push('missing_featured_image_alt');
            }

            const acfWithoutAlt = countImagesWithoutAlt(post.acf);
            if (acfWithoutAlt > 0) {
              issues.push('acf_images_missing_alt');
              details.acf_images_missing_alt = acfWithoutAlt;
            }

            if (post.type === 'post' && !post.excerpt?.raw?.trim()) {
              issues.push('missing_excerpt');
            }
            if (features.yoast && post.yoast_head_json && !post.yoast_head_json.description) {
              issues.push('missing_meta_description');
            }
            if (new Date(post.modified) < staleBefore) {
              issues.push('stale');
              details.last_modified = post.modified.slice(0, 10);
            }

            if (issues.length === 0) {
              continue;
            }
            issues.forEach((code) => (counts[code] = (counts[code] ?? 0) + 1));
            items.push({
              id: post.id,
              type: post.type,
              ...(post.status !== 'publish' ? { status: post.status } : {}),
              title: decodeEntities(post.title.rendered),
              url: post.link,
              issues,
              ...(Object.keys(details).length > 0 ? { details } : {}),
            });
          }
        }

        return jsonResult({
          scanned,
          items_with_issues: items.length,
          issue_counts: counts,
          issue_descriptions: Object.fromEntries(Object.keys(counts).map((code) => [code, DESCRIPTIONS[code]])),
          items,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/** Menus need the edit_theme_options capability (Administrators), so this is registered only when the user has it. */
export function registerMenuTools(server: McpServer, wp: WpClient): void {
  server.registerTool(
    'get_menu',
    {
      title: 'Get a navigation menu',
      description:
        'Returns a navigation menu as a tree of titles and URLs. Pass a menu slug or theme location; ' +
        'omit both to list the menus and their locations.',
      inputSchema: {
        menu: z.string().optional().describe('Menu slug, e.g. "main-menu"'),
        location: z.string().optional().describe('Theme location, e.g. "primary"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ menu, location }) => {
      try {
        const menus = (await wp.get<WpMenu[]>('wp/v2/menus', { per_page: 100, _fields: 'id,name,slug,locations' }))
          .data;
        if (!menu && !location) {
          return jsonResult(menus.map((m) => ({ slug: m.slug, name: decodeEntities(m.name), locations: m.locations })));
        }

        const match = menus.find((m) => (menu ? m.slug === menu : m.locations.includes(location ?? '')));
        if (!match) {
          throw new Error(
            `No menu found for ${menu ? `slug "${menu}"` : `location "${location}"`}. ` +
              `Menus: ${menus.map((m) => `${m.slug} (${m.locations.join(', ') || 'no location'})`).join('; ')}.`,
          );
        }

        const items = (
          await wp.get<WpMenuItem[]>('wp/v2/menu-items', {
            menus: match.id,
            per_page: 100,
            _fields: 'id,title,url,parent,menu_order,object,object_id',
          })
        ).data;
        return jsonResult({ menu: match.slug, name: decodeEntities(match.name), items: buildMenuTree(items) });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
