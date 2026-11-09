import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AcfSchema } from '../wp/acf-schema.js';
import type { WpClient } from '../wp/client.js';
import { detectFeatures, type SiteFeatures } from '../wp/features.js';
import { decodeEntities, truncate } from '../wp/format.js';
import type { SiteModel } from '../wp/site-model.js';
import { generateTypes } from '../wp/ts-types.js';
import { READ_ONLY } from './inputs.js';
import { jsonResult, toolError } from './result.js';

/** Routes sample_payload refuses, because they expose users, credentials, or site configuration. */
const BLOCKED_ROUTE = /^wp\/v2\/(users|settings|plugins|themes|application-passwords|sidebars|widgets|widget-types)\b/;
const ALLOWED_ROUTE = /^(wp\/v2\/|yoast\/v1\/get_head$)/;

/** Large fields that make sample payloads hard to read. */
const NOISY_FIELDS = new Set(['_links', 'yoast_head', 'class_list']);

interface Check {
  readonly name: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly details: string;
}

/** Removes noisy fields at the top level of each item. */
function cleanPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanPayload);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !NOISY_FIELDS.has(key)));
  }
  return value;
}

/** Post type slugs listed in a Yoast or core WordPress sitemap index. */
export function sitemapPostTypes(xml: string): string[] {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');
  const types = new Set<string>();
  for (const loc of locs) {
    const yoast = loc.match(/\/([a-z0-9_-]+)-sitemap\d*\.xml$/);
    const core = loc.match(/wp-sitemap-posts-([a-z0-9_-]+)-\d+\.xml$/);
    const slug = core?.[1] ?? yoast?.[1];
    // Yoast also lists taxonomies (category-sitemap) and authors; those aren't post types.
    if (slug && !['author', 'category', 'post_tag', 'tag'].includes(slug) && !loc.includes('wp-sitemap-taxonomies')) {
      types.add(slug);
    }
  }
  return [...types];
}

export function registerDevTools(
  server: McpServer,
  wp: WpClient,
  site: SiteModel,
  acfSchema: AcfSchema,
  features: SiteFeatures,
): void {
  server.registerTool(
    'describe_content_model',
    {
      title: 'Describe the content model',
      description:
        'Overview for PWA developers: each post type with its REST route, taxonomies (with REST field names), ' +
        'and the ACF field groups and field names that apply to it.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const [types, taxonomies] = await Promise.all([site.postTypes(), site.taxonomies()]);
        const model = await Promise.all(
          types.map(async (type) => {
            let acf: unknown;
            if (acfSchema.hasAcfJson) {
              acf = (await acfSchema.groupsForPostType(type.slug)).map((group) => ({
                group: group.title,
                key: group.key,
                location: group.location,
                show_in_rest: group.showInRest,
                fields: group.fields.map((field) => `${field.name} (${field.type})`),
              }));
            } else {
              const schema = await acfSchema.restSchema(type.slug);
              acf = schema?.properties ? Object.keys(schema.properties) : [];
            }
            return {
              post_type: type.slug,
              name: decodeEntities(type.name),
              rest_route: `/wp-json/${type.rest_namespace}/${type.rest_base}`,
              hierarchical: type.hierarchical,
              taxonomies: type.taxonomies.map((slug) => {
                const tax = taxonomies.find((t) => t.slug === slug);
                return { taxonomy: slug, rest_field: tax?.rest_base ?? slug };
              }),
              acf,
            };
          }),
        );

        const optionsGroups = acfSchema.hasAcfJson
          ? (await acfSchema.allGroups())
              .filter((group) => group.location?.some((rule) => rule.startsWith('options_page')))
              .map((group) => ({ group: group.title, note: 'ACF options page: not available through the REST API' }))
          : [];

        return jsonResult({
          acf_source: acfSchema.hasAcfJson ? 'acf-json' : 'rest-schema',
          post_types: model,
          ...(optionsGroups.length > 0 ? { options_pages: optionsGroups } : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_acf_schema',
    {
      title: 'Get ACF field schema',
      description:
        'Full ACF field definitions: labels, types, return formats, choices, required flags, sub fields, and ' +
        'location rules. Reads acf-json when ACF_JSON_PATH is set (all groups, including options pages); ' +
        'otherwise the REST schema of one post type (names and JSON types only).',
      inputSchema: {
        post_type: z
          .string()
          .optional()
          .describe('Only groups that apply to this post type. Required without acf-json.'),
      },
      annotations: READ_ONLY,
    },
    async ({ post_type }) => {
      try {
        if (acfSchema.hasAcfJson) {
          const groups = post_type ? await acfSchema.groupsForPostType(post_type) : await acfSchema.allGroups();
          return jsonResult({ source: 'acf-json', groups });
        }
        if (!post_type) {
          throw new Error('Without ACF_JSON_PATH, pass post_type to read its REST schema.');
        }
        return jsonResult({ source: 'rest-schema', post_type, acf: await acfSchema.restSchema(post_type) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'sample_payload',
    {
      title: 'Show a sample REST payload',
      description:
        'Returns the raw JSON a PWA would receive from a WordPress REST route (wp/v2/* or yoast/v1/get_head), ' +
        'with _links and yoast_head removed. User, settings, plugin, and theme routes are blocked.',
      inputSchema: {
        route: z.string().describe('REST route without /wp-json/, e.g. "wp/v2/project" or "wp/v2/pages/4"'),
        query: z
          .record(z.string(), z.string())
          .optional()
          .describe('Query parameters, e.g. {"acf_format": "standard", "_embed": "1"}'),
        per_page: z.number().int().min(1).max(5).default(1).describe('Items for collection routes'),
        max_chars: z.number().int().min(1000).max(100000).default(12000),
      },
      annotations: READ_ONLY,
    },
    async ({ route, query, per_page, max_chars }) => {
      try {
        const clean = route.replace(/^\/?(wp-json\/)?/, '').replace(/\/+$/, '');
        if (!ALLOWED_ROUTE.test(clean) || BLOCKED_ROUTE.test(clean)) {
          throw new Error(`Route "${clean}" is not allowed. Use a content route under wp/v2/, or yoast/v1/get_head.`);
        }
        const isItem = /\/\d+$/.test(clean) || clean.startsWith('yoast/');
        const res = await wp.get<unknown>(clean, { ...(isItem ? {} : { per_page }), ...(query ?? {}) });
        const text = JSON.stringify(cleanPayload(res.data), null, 2);
        return jsonResult({
          route: `/wp-json/${clean}`,
          ...(res.total !== undefined ? { total: res.total } : {}),
          payload_preview: truncate(text, max_chars),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'generate_ts_types',
    {
      title: 'Generate TypeScript types',
      description:
        "Generates TypeScript interfaces for a post type's REST response, including typed ACF fields " +
        '(repeaters, images, relationships, choices) with labels as comments. ' +
        '"standard" matches ?acf_format=standard and needs acf-json; "light" matches the default response.',
      inputSchema: {
        post_type: z.string().describe('Post type slug, e.g. "project" or "page"'),
        acf_format: z.enum(['standard', 'light']).default('standard'),
      },
      annotations: READ_ONLY,
    },
    async ({ post_type, acf_format }) => {
      try {
        const type = (await site.postTypes()).find((t) => t.slug === post_type);
        if (!type) {
          throw new Error(`Unknown post type "${post_type}".`);
        }
        const taxonomies = await site.taxonomies();
        const target = {
          postType: type.slug,
          hierarchical: type.hierarchical,
          taxonomyFields: type.taxonomies
            .map((slug) => taxonomies.find((t) => t.slug === slug)?.rest_base)
            .filter((field): field is string => field !== undefined),
        };

        let note: string | undefined;
        let generated;
        if (acfSchema.hasAcfJson) {
          const groups = await acfSchema.groupsForPostType(type.slug);
          generated = generateTypes(target, {
            from: 'acf-json',
            format: acf_format,
            fields: groups.flatMap((g) => g.fields),
          });
          const hidden = groups.filter((g) => !g.showInRest).map((g) => g.title);
          if (hidden.length > 0) {
            note = `Groups with "Show in REST API" off are typed but won't appear in responses: ${hidden.join(', ')}.`;
          }
        } else {
          note =
            'ACF_JSON_PATH is not set, so these types come from the REST schema ("light" format: IDs for images and ' +
            'related posts, no labels). Groups placed by page template may be missing from that schema.';
          generated = generateTypes(target, {
            from: 'rest-schema',
            format: 'light',
            schema: await acfSchema.restSchema(type.slug),
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: `${note ? `Note: ${note}\n\n` : ''}\`\`\`ts\n${generated.code}\`\`\``,
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'check_site_requirements',
    {
      title: 'Check headless site requirements',
      description:
        'Checks the site against the requirements for headless use: public post types missing from the REST API, ' +
        'ACF field groups not saved to acf-json or not shown in REST, and Application Password availability.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const checks: Check[] = [];
        const types = await site.postTypes();
        const restSlugs = new Set(types.map((type) => type.slug));

        // 1. Public post types hidden from REST, found through the sitemap.
        const sitemapPath = features.yoast ? '/sitemap_index.xml' : '/wp-sitemap.xml';
        const sitemap = await wp.probe(sitemapPath);
        if (sitemap.status === 200) {
          const missing = sitemapPostTypes(sitemap.text).filter((slug) => !restSlugs.has(slug));
          checks.push(
            missing.length === 0
              ? {
                  name: 'post_types_in_rest',
                  status: 'pass',
                  details: `Every post type in ${sitemapPath} is in the REST API.`,
                }
              : {
                  name: 'post_types_in_rest',
                  status: 'fail',
                  details: `In the sitemap but not in REST: ${missing.join(', ')}. Register them with show_in_rest => true.`,
                },
          );
        } else {
          checks.push({
            name: 'post_types_in_rest',
            status: 'warn',
            details: `Couldn't read ${sitemapPath} (HTTP ${sitemap.status}) to look for hidden post types.`,
          });
        }

        // 2. ACF field groups: saved to acf-json, and shown in REST.
        if (!acfSchema.hasAcfJson) {
          checks.push({
            name: 'acf_json',
            status: 'warn',
            details:
              "ACF_JSON_PATH is not set, so acf-json can't be checked. Field groups should be saved to the theme's acf-json folder.",
          });
        } else {
          const groups = await acfSchema.allGroups();
          checks.push({
            name: 'acf_json',
            status: 'pass',
            details: `${groups.length} field group(s) found in acf-json.`,
          });

          const hidden = groups.filter(
            (group) => !group.showInRest && !group.location?.every((rule) => rule.startsWith('options_page')),
          );
          checks.push(
            hidden.length === 0
              ? {
                  name: 'acf_show_in_rest',
                  status: 'pass',
                  details: 'Every content field group has "Show in REST API" on.',
                }
              : {
                  name: 'acf_show_in_rest',
                  status: 'fail',
                  details: `"Show in REST API" is off for: ${hidden.map((g) => g.title).join(', ')}.`,
                },
          );

          const options = groups.filter((group) => group.location?.some((rule) => rule.startsWith('options_page')));
          if (options.length > 0) {
            checks.push({
              name: 'acf_options_pages',
              status: 'warn',
              details:
                `Options page groups (${options.map((g) => g.title).join(', ')}) can't be read through the REST API; ` +
                'site-wide settings stored there are invisible to the PWA and to AI clients.',
            });
          }
        }

        // 3. Application Passwords, needed by the editor and dev profiles.
        const index = (await wp.get<{ authentication?: Record<string, unknown> | unknown[] }>('')).data;
        const appPasswords =
          index.authentication !== undefined &&
          !Array.isArray(index.authentication) &&
          'application-passwords' in index.authentication;
        checks.push(
          appPasswords
            ? { name: 'application_passwords', status: 'pass', details: 'Application Passwords are available.' }
            : {
                name: 'application_passwords',
                status: 'warn',
                details:
                  'The REST index does not advertise Application Passwords. They may be disabled (for example by Wordfence), ' +
                  'or hidden from anonymous requests.',
              },
        );

        const summary = { pass: 0, warn: 0, fail: 0 };
        checks.forEach((check) => (summary[check.status] += 1));
        return jsonResult({ summary, checks });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'site_health',
    {
      title: 'Check site health for a PWA',
      description:
        'Reports what a PWA build needs to know: WordPress version (if published), REST namespaces and detected ' +
        'plugins, HTTPS, timezone, and whether the REST API sends CORS headers for a given PWA origin.',
      inputSchema: {
        pwa_origin: z
          .string()
          .regex(/^https?:\/\/[^/]+$/, 'An origin: scheme and host, optional port, no path')
          .optional()
          .describe('The PWA origin to test CORS for, e.g. "http://localhost:5173"'),
      },
      annotations: READ_ONLY,
    },
    async ({ pwa_origin }) => {
      try {
        const index = (
          await wp.get<{
            name: string;
            home: string;
            url: string;
            namespaces: string[];
            timezone_string?: string;
            gmt_offset?: number | string;
          }>('')
        ).data;
        const home = await wp.probe('/');
        const generator = home.text.match(/<meta name="generator" content="WordPress ([^"]+)"/i)?.[1];

        let cors: Record<string, unknown> | undefined;
        if (pwa_origin) {
          const res = await wp.probe('/wp-json/wp/v2/types', { Origin: pwa_origin });
          const allowOrigin = res.headers.get('access-control-allow-origin');
          cors = {
            origin: pwa_origin,
            access_control_allow_origin: allowOrigin,
            allowed: allowOrigin === pwa_origin || allowOrigin === '*',
            note:
              'WordPress echoes the Origin on REST responses by default. If "allowed" is false, a plugin or server ' +
              'config is limiting CORS; a PWA can also call REST from its own backend instead of the browser.',
          };
        }

        return jsonResult({
          site: { name: decodeEntities(index.name), home: index.home, https: index.home.startsWith('https://') },
          wordpress_version: generator ?? 'not published (generator meta tag removed)',
          timezone: index.timezone_string || `UTC offset ${index.gmt_offset ?? 0}`,
          rest_namespaces: index.namespaces,
          features: detectFeatures(index.namespaces),
          ...(cors ? { cors } : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
