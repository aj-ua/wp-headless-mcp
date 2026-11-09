import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config, CptToolConfig } from '../config.js';
import { decodeEntities } from '../wp/format.js';
import type { PostService } from '../wp/posts.js';
import type { SiteModel } from '../wp/site-model.js';
import type { WpType } from '../wp/types.js';
import { getInputs, listInputs, READ_ONLY } from './inputs.js';
import { jsonResult, toolError } from './result.js';

/** Core types already covered by the generic tools. */
const CORE_TYPES = new Set(['post', 'page']);

export interface ResolvedCpt extends CptToolConfig {
  readonly label: string;
  readonly taxonomies: string[];
}

/** "case-study" → "case_study"; "case_study" → "case_studies". */
function toSnake(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/.test(word)) {
    return `${word}es`;
  }
  return `${word}s`;
}

/** Works out which custom post types get named tools, and what the tools are called. */
export async function resolveCpts(config: Config, site: SiteModel): Promise<ResolvedCpt[]> {
  if (config.cpts === 'none') {
    return [];
  }

  const types = await site.postTypes();
  const bySlug = new Map<string, WpType>(types.map((type) => [type.slug, type]));

  if (config.cpts === 'auto') {
    return types
      .filter((type) => !CORE_TYPES.has(type.slug))
      .map((type) => {
        const singular = toSnake(type.slug);
        return {
          postType: type.slug,
          singular,
          plural: pluralize(singular),
          label: decodeEntities(type.name),
          taxonomies: type.taxonomies,
        };
      });
  }

  return config.cpts.map((entry) => {
    const type = bySlug.get(entry.postType);
    if (!type) {
      throw new Error(
        `MCP_CPTS lists post type "${entry.postType}", but the site's REST API doesn't expose it. ` +
          `Available: ${types.map((t) => t.slug).join(', ')}.`,
      );
    }
    return { ...entry, label: decodeEntities(type.name), taxonomies: type.taxonomies };
  });
}

/** Registers a list_<plural> and get_<singular> tool for each custom post type. */
export function registerCptTools(server: McpServer, posts: PostService, cpts: ResolvedCpt[]): void {
  for (const cpt of cpts) {
    const taxonomyHint =
      cpt.taxonomies.length > 0 ? `One of: ${cpt.taxonomies.join(', ')}` : 'This post type has no taxonomies';

    server.registerTool(
      `list_${cpt.plural}`,
      {
        title: `List ${cpt.label}`,
        description:
          `Lists published ${cpt.label.toLowerCase()} (post type "${cpt.postType}"), newest first by default, ` +
          'with shortened ACF fields. Use ' +
          `get_${cpt.singular} for one item in full.`,
        inputSchema: {
          ...listInputs,
          taxonomy: z.string().optional().describe(`Taxonomy to filter by. ${taxonomyHint}.`),
          terms: z.array(z.string()).optional().describe('Term slugs or IDs in that taxonomy'),
          include_acf: z.boolean().default(true).describe('Include shortened ACF fields for each item'),
        },
        annotations: READ_ONLY,
      },
      async (input) => {
        try {
          if (input.taxonomy && !cpt.taxonomies.includes(input.taxonomy)) {
            throw new Error(`"${input.taxonomy}" doesn't apply to ${cpt.postType}. ${taxonomyHint}.`);
          }
          return jsonResult(
            await posts.list({
              postType: cpt.postType,
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
      `get_${cpt.singular}`,
      {
        title: `Get one ${cpt.label} item`,
        description:
          `Returns one published item of post type "${cpt.postType}" by ID or slug, ` +
          'with body as Markdown, featured image, terms, and all ACF fields (related posts include their URLs).',
        inputSchema: getInputs,
        annotations: READ_ONLY,
      },
      async ({ id, slug, include_acf, max_chars }) => {
        try {
          return jsonResult(
            await posts.get({ postType: cpt.postType, id, slug, includeAcf: include_acf, maxChars: max_chars }),
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }
}
