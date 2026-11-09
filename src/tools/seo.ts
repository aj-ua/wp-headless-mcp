import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WpApiError, type WpClient } from '../wp/client.js';
import { decodeEntities } from '../wp/format.js';
import { findSeoIssues, toSeoMeta, type SeoIssue, type YoastHeadJson } from '../wp/seo.js';
import type { SiteModel } from '../wp/site-model.js';
import type { WpRendered } from '../wp/types.js';
import { getInputs, READ_ONLY } from './inputs.js';
import { jsonResult, toolError } from './result.js';

interface WpSeoPost {
  readonly id: number;
  readonly type: string;
  readonly link: string;
  readonly title: WpRendered;
  readonly yoast_head_json?: YoastHeadJson;
}

const SEO_FIELDS = 'id,type,link,title,yoast_head_json';
const SCAN_PAGE_SIZE = 100;

const NO_YOAST_DATA =
  'No Yoast SEO data in the REST response. Check that Yoast SEO is active and that this post type is indexable in Yoast settings.';

function seoForPost(post: WpSeoPost): Record<string, unknown> {
  if (!post.yoast_head_json) {
    throw new Error(NO_YOAST_DATA);
  }
  const meta = toSeoMeta(post.yoast_head_json);
  return {
    post: { id: post.id, type: post.type, title: decodeEntities(post.title.rendered), url: post.link },
    ...meta,
    issues: findSeoIssues(meta, post.link),
  };
}

function sameUrl(a: string, b: string): boolean {
  const normalize = (url: string): string =>
    url
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * Finds the published post behind a URL by its last path segment (the slug),
 * checking each content type and comparing the full permalink.
 */
async function findPostByUrl(wp: WpClient, site: SiteModel, url: string): Promise<WpSeoPost | undefined> {
  const slug = new URL(url).pathname.split('/').filter(Boolean).pop();
  if (!slug) {
    return undefined;
  }
  for (const type of await site.postTypes()) {
    const res = await wp.get<WpSeoPost[]>(`${type.rest_namespace}/${type.rest_base}`, {
      slug,
      _fields: SEO_FIELDS,
    });
    const match = res.data.find((post) => sameUrl(post.link, url));
    if (match) {
      return match;
    }
  }
  return undefined;
}

/**
 * SEO data for any URL. Posts and pages are read through the REST API, which is reliable;
 * Yoast's get_head endpoint is the fallback for other pages such as the home page or archives.
 */
async function seoForUrl(wp: WpClient, site: SiteModel, url: string): Promise<Record<string, unknown>> {
  const post = await findPostByUrl(wp, site, url);
  if (post) {
    return seoForPost(post);
  }

  try {
    const res = await wp.get<{ status?: number; json?: YoastHeadJson }>('yoast/v1/get_head', { url });
    if (!res.data.json) {
      throw new Error(`Yoast returned no SEO data for ${url}.`);
    }
    const meta = toSeoMeta(res.data.json);
    return { url, ...meta, issues: findSeoIssues(meta, url) };
  } catch (error) {
    if (error instanceof WpApiError && error.status === 404) {
      throw new Error(
        `No SEO data for ${url}: it doesn't match a published post or page, and Yoast's URL lookup ` +
          'returned "page not found". Check the URL, or pass post_type with id or slug.',
        { cause: error },
      );
    }
    throw error;
  }
}

/** A per-code explanation for the summary; length-specific numbers vary per item, so they're dropped. */
function describeIssue(issue: SeoIssue): string {
  const generic: Record<string, string> = {
    title_too_long: 'SEO title is over about 60 characters and may be cut off in search results.',
    description_too_short: 'Meta description is under 120 characters; aim for 120–156.',
    description_too_long: 'Meta description is over 156 characters and may be cut off.',
    canonical_mismatch: 'Canonical URL differs from the page URL.',
  };
  return `${issue.severity}: ${generic[issue.code] ?? issue.message} Use get_seo_meta for details on one item.`;
}

export function registerSeoTools(server: McpServer, wp: WpClient, site: SiteModel): void {
  server.registerTool(
    'get_seo_meta',
    {
      title: 'Get SEO metadata',
      description:
        'Returns Yoast SEO data for one post, page, or custom post (by post_type with id or slug), ' +
        'or for any URL on the site: SEO title, meta description, canonical URL, indexing, ' +
        'Open Graph and Twitter data, schema types, and a list of SEO issues.',
      inputSchema: {
        post_type: z.string().default('page').describe('Post type slug, e.g. "page" or "project"'),
        id: getInputs.id,
        slug: getInputs.slug,
        url: z
          .string()
          .url()
          .optional()
          .describe('Any URL on the site (for archives and other non-post pages). Overrides post_type, id, and slug.'),
      },
      annotations: READ_ONLY,
    },
    async ({ post_type, id, slug, url }) => {
      try {
        if (url) {
          return jsonResult(await seoForUrl(wp, site, url));
        }
        if (id === undefined && slug === undefined) {
          throw new Error('Provide url, or post_type with id or slug.');
        }

        const route = await site.postTypeRoute(post_type);
        const post =
          id !== undefined
            ? (await wp.get<WpSeoPost>(`${route}/${id}`, { _fields: SEO_FIELDS })).data
            : (await wp.get<WpSeoPost[]>(route, { slug, _fields: SEO_FIELDS })).data[0];

        if (!post) {
          throw new Error(`No published ${post_type} found with slug "${slug}".`);
        }
        return jsonResult(seoForPost(post));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'find_seo_issues',
    {
      title: 'Find SEO issues across the site',
      description:
        'Scans published items and lists the ones with SEO problems: noindex, missing or too long titles, ' +
        'missing or badly sized meta descriptions, missing social images, and canonical mismatches. ' +
        'Includes a count per issue type.',
      inputSchema: {
        post_type: z
          .string()
          .optional()
          .describe('Post type slug to scan. Omit to scan every content type (up to 100 items each).'),
        severity: z
          .enum(['all', 'error'])
          .default('all')
          .describe('"error" lists only serious issues (noindex, missing title)'),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe('Page of 100 items to scan, when one post type has more than 100'),
      },
      annotations: READ_ONLY,
    },
    async ({ post_type, severity, page }) => {
      try {
        const types = post_type ? [post_type] : (await site.postTypes()).map((type) => type.slug);
        const counts: Record<string, number> = {};
        // Each issue's explanation is listed once; items carry only the codes.
        const descriptions: Record<string, string> = {};
        const items: { id: number; type: string; title: string; url: string; issues: string[] }[] = [];
        const scanned: Record<string, { scanned: number; total: number }> = {};
        let missingYoast = 0;

        for (const type of types) {
          const route = await site.postTypeRoute(type);
          const res = await wp.get<WpSeoPost[]>(route, { per_page: SCAN_PAGE_SIZE, page, _fields: SEO_FIELDS });
          scanned[type] = { scanned: res.data.length, total: res.total ?? res.data.length };

          for (const post of res.data) {
            if (!post.yoast_head_json) {
              missingYoast += 1;
              continue;
            }
            const issues = findSeoIssues(toSeoMeta(post.yoast_head_json), post.link).filter(
              (issue) => severity === 'all' || issue.severity === 'error',
            );
            if (issues.length === 0) {
              continue;
            }
            for (const issue of issues) {
              counts[issue.code] = (counts[issue.code] ?? 0) + 1;
              descriptions[issue.code] ??= describeIssue(issue);
            }
            items.push({
              id: post.id,
              type: post.type,
              title: decodeEntities(post.title.rendered),
              url: post.link,
              issues: issues.map((issue) => issue.code),
            });
          }
        }

        return jsonResult({
          scanned,
          items_with_issues: items.length,
          issue_counts: counts,
          issue_descriptions: descriptions,
          ...(missingYoast > 0 ? { items_without_yoast_data: missingYoast } : {}),
          items,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
