import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AcfFieldDef, AcfSchema } from '../wp/acf-schema.js';
import { decodeEntities } from '../wp/format.js';
import type { PostService } from '../wp/posts.js';
import { ACF_NOT_EXPOSED, simplifyAcf } from '../wp/shape.js';
import { getInputs, READ_ONLY } from './inputs.js';
import { jsonResult, toolError } from './result.js';

interface LabeledField {
  readonly name: string;
  readonly label?: string;
  readonly type: string;
  readonly group: string;
  readonly value: unknown;
  readonly sub_fields?: Omit<LabeledField, 'value' | 'group'>[];
}

function describeSubFields(fields: AcfFieldDef[] | undefined): LabeledField['sub_fields'] {
  return fields?.map((field) => ({
    name: field.name,
    ...(field.label ? { label: field.label } : {}),
    type: field.type,
    ...(field.subFields ? { sub_fields: describeSubFields(field.subFields) } : {}),
  }));
}

export function registerAcfTools(server: McpServer, posts: PostService, acfSchema: AcfSchema): void {
  server.registerTool(
    'get_acf_fields',
    {
      title: 'Get ACF fields with labels',
      description:
        "Returns the ACF custom fields of one item with each field's label, type, field group, and value. " +
        'Use it to understand what each field means; get_post already includes the values alone.',
      inputSchema: {
        post_type: z.string().default('page').describe('Post type slug, e.g. "page" or "project"'),
        id: getInputs.id,
        slug: getInputs.slug,
        max_chars: getInputs.max_chars,
      },
      annotations: READ_ONLY,
    },
    async ({ post_type, id, slug, max_chars }) => {
      try {
        const post = await posts.getRaw({ postType: post_type, id, slug, includeAcf: true });
        const values = simplifyAcf(post.acf, { maxChars: max_chars, compact: false }) ?? {};
        await posts.addRelatedUrls(values);

        const schema = await acfSchema.forPost({
          postType: post.type,
          postId: post.id,
          template: post.template ?? '',
        });

        const described = new Set<string>();
        const fields: LabeledField[] = [];
        for (const group of schema.groups) {
          for (const field of group.fields) {
            described.add(field.name);
            fields.push({
              name: field.name,
              ...(field.label ? { label: field.label } : {}),
              type: field.type,
              group: group.title,
              value: values[field.name] ?? null,
              ...(field.subFields ? { sub_fields: describeSubFields(field.subFields) } : {}),
            });
          }
        }

        // Values present in REST but missing from the schema (e.g. acf-json out of date).
        const undescribed = Object.keys(values).filter((name) => !described.has(name));

        return jsonResult({
          post: { id: post.id, type: post.type, title: decodeEntities(post.title.rendered), url: post.link },
          schema_source: schema.source,
          fields,
          ...(undescribed.length > 0
            ? { undescribed_values: Object.fromEntries(undescribed.map((name) => [name, values[name]])) }
            : {}),
          ...(Object.keys(values).length === 0 ? { note: ACF_NOT_EXPOSED } : {}),
          ...(schema.groups.some((g) => !g.showInRest)
            ? { warning: 'Some matching field groups have "Show in REST API" off, so their values are missing.' }
            : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
