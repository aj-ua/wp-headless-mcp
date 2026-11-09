import { z } from 'zod';

/** Input fields shared by every "list" tool (generic and per custom post type). */
export const listInputs = {
  search: z.string().optional().describe('Keyword filter'),
  after: z.string().optional().describe('Only items published after this date (YYYY-MM-DD or ISO 8601)'),
  before: z.string().optional().describe('Only items published before this date (YYYY-MM-DD or ISO 8601)'),
  modified_after: z
    .string()
    .optional()
    .describe('Only items last modified after this date (YYYY-MM-DD or ISO 8601); finds recent edits'),
  orderby: z
    .enum(['date', 'modified', 'title', 'menu_order', 'relevance'])
    .default('date')
    .describe('Sort field. "relevance" requires search.'),
  order: z.enum(['asc', 'desc']).default('desc'),
  per_page: z.number().int().min(1).max(50).default(10),
  page: z.number().int().min(1).default(1),
};

/** Input fields shared by every "get" tool. */
export const getInputs = {
  id: z.number().int().positive().optional().describe('Post ID. Provide either id or slug.'),
  slug: z.string().min(1).optional().describe('Post slug. Provide either id or slug.'),
  include_acf: z.boolean().default(true).describe('Include ACF custom fields'),
  max_chars: z
    .number()
    .int()
    .min(500)
    .max(50000)
    .default(8000)
    .describe('Maximum characters of body text (and of each long ACF text field) to return'),
};

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
