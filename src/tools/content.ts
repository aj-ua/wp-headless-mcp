import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AcfSearch } from '../wp/acf-search.js';
import type { WpClient } from '../wp/client.js';
import { decodeEntities, htmlToText } from '../wp/format.js';
import type { PostService } from '../wp/posts.js';
import type { SiteModel } from '../wp/site-model.js';
import type { WpTerm } from '../wp/types.js';
import { getInputs, listInputs, READ_ONLY } from './inputs.js';
import { jsonResult, toolError } from './result.js';

interface WpSearchResult {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly type: string;
  readonly subtype: string;
}

export function registerContentTools(
  server: McpServer,
  wp: WpClient,
  site: SiteModel,
  posts: PostService,
  acfSearch: AcfSearch,
): void {
  server.registerTool(
    'search_content',
    {
      title: 'Search site content',
      description:
        'Full-text search across published posts, pages, and custom post types. "results" are title and body ' +
        'matches from WordPress search; "acf_matches" are items whose ACF custom fields contain every search word ' +
        '(WordPress search skips ACF, and on many sites most text lives there). Use get_post to read a result.',
      inputSchema: {
        query: z.string().min(1).describe('Search terms'),
        post_type: z
          .string()
          .optional()
          .describe('Limit to one post type slug (see list_post_types), e.g. "page" or "project"'),
        include_acf: z.boolean().default(true).describe('Also search ACF field values (first page only)'),
        per_page: z.number().int().min(1).max(50).default(10).describe('Results per page'),
        page: z.number().int().min(1).default(1).describe('Page number'),
      },
      annotations: READ_ONLY,
    },
    async ({ query, post_type, include_acf, per_page, page }) => {
      try {
        const res = await wp.get<WpSearchResult[]>('wp/v2/search', {
          search: query,
          type: 'post',
          subtype: post_type,
          per_page,
          page,
        });
        const results = res.data.map((item) => ({
          id: item.id,
          title: decodeEntities(item.title),
          url: item.url,
          post_type: item.subtype,
        }));

        // ACF matches are added on the first page only, so paging through results doesn't repeat them.
        let acf: Record<string, unknown> = {};
        if (include_acf && page === 1) {
          const found = await acfSearch.search(query, post_type);
          const shown = new Set(results.map((item) => item.id));
          const extra = found.hits.filter((hit) => !shown.has(hit.id));
          acf = {
            acf_matches: extra.slice(0, per_page),
            ...(extra.length > per_page ? { acf_matches_total: extra.length } : {}),
            ...(found.truncated
              ? { acf_note: 'Some post types have more than 500 items; only the newest 500 were searched in ACF.' }
              : {}),
          };
        }

        return jsonResult({
          total: res.total ?? res.data.length,
          total_pages: res.totalPages,
          page,
          results,
          ...acf,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_post_types',
    {
      title: 'List content types',
      description:
        'Lists the content types on the site (posts, pages, and custom post types such as projects), ' +
        'with how many published items each has and which taxonomies apply. Call this first to learn what the site contains.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const types = await site.postTypes();
        const counts = await Promise.all(
          types.map(async (type) => {
            const res = await wp.get<unknown[]>(`${type.rest_namespace}/${type.rest_base}`, {
              per_page: 1,
              _fields: 'id',
            });
            return res.total ?? res.data.length;
          }),
        );

        return jsonResult(
          types.map((type, i) => ({
            slug: type.slug,
            name: decodeEntities(type.name),
            ...(type.description ? { description: type.description } : {}),
            hierarchical: type.hierarchical,
            taxonomies: type.taxonomies,
            published_count: counts[i],
          })),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_post',
    {
      title: 'Get a post, page, or custom post',
      description:
        'Returns one published item by ID or slug: title, URL, dates, author, featured image, terms, ' +
        'body as Markdown, and ACF custom fields. Works for any post type (see list_post_types).',
      inputSchema: {
        post_type: z.string().default('post').describe('Post type slug, e.g. "post", "page", "project"'),
        ...getInputs,
      },
      annotations: READ_ONLY,
    },
    async ({ post_type, id, slug, include_acf, max_chars }) => {
      try {
        return jsonResult(
          await posts.get({ postType: post_type, id, slug, includeAcf: include_acf, maxChars: max_chars }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_posts',
    {
      title: 'List posts, pages, or custom posts',
      description:
        'Lists published items of one post type, newest first by default, with optional filters. ' +
        'Returns summaries (title, URL, dates, excerpt). Use get_post for the full content.',
      inputSchema: {
        post_type: z.string().default('post').describe('Post type slug, e.g. "post", "page", "project"'),
        taxonomy: z.string().optional().describe('Taxonomy slug to filter by, e.g. "category" or "post_tag"'),
        terms: z
          .array(z.string())
          .optional()
          .describe('Term slugs or numeric IDs in that taxonomy. Requires taxonomy.'),
        include_acf: z
          .boolean()
          .default(false)
          .describe('Include shortened ACF fields for each item (useful when content lives in ACF)'),
        ...listInputs,
      },
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        return jsonResult(
          await posts.list({
            postType: input.post_type,
            search: input.search,
            taxonomy: input.taxonomy,
            terms: input.terms,
            after: input.after,
            before: input.before,
            modifiedAfter: input.modified_after,
            orderby: input.orderby,
            order: input.order,
            includeAcf: input.include_acf,
            perPage: input.per_page,
            page: input.page,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_terms',
    {
      title: 'List categories, tags, or custom taxonomy terms',
      description:
        'Lists terms in a taxonomy with how many published items use each. ' +
        'Term slugs can be passed to list_posts to filter.',
      inputSchema: {
        taxonomy: z.string().default('category').describe('Taxonomy slug, e.g. "category" or "post_tag"'),
        search: z.string().optional().describe('Keyword filter on term names'),
        hide_empty: z.boolean().default(false).describe('Skip terms with no published items'),
        per_page: z.number().int().min(1).max(100).default(50),
        page: z.number().int().min(1).default(1),
      },
      annotations: READ_ONLY,
    },
    async ({ taxonomy, search, hide_empty, per_page, page }) => {
      try {
        const tax = await site.taxonomyRoute(taxonomy);
        const res = await wp.get<WpTerm[]>(tax.route, {
          search,
          hide_empty,
          per_page,
          page,
          orderby: 'count',
          order: 'desc',
          _fields: 'id,name,slug,description,count,parent,link,taxonomy',
        });

        return jsonResult({
          taxonomy,
          total: res.total ?? res.data.length,
          total_pages: res.totalPages,
          page,
          terms: res.data.map((term) => ({
            id: term.id,
            name: decodeEntities(term.name),
            slug: term.slug,
            count: term.count,
            ...(term.parent ? { parent_id: term.parent } : {}),
            ...(term.description ? { description: htmlToText(term.description) } : {}),
            url: term.link,
          })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
