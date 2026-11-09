import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Profile } from '../config.js';
import type { SiteFeatures } from '../wp/features.js';

export interface PromptContext {
  readonly profile: Profile;
  readonly features: SiteFeatures;
  /** Names of the generated get_<cpt> tools, e.g. ["get_project"]. */
  readonly cptGetTools: string[];
}

function userPrompt(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/** Days ago as YYYY-MM-DD, for date filters. */
function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

export function registerPrompts(server: McpServer, context: PromptContext): void {
  const readTools = ['get_post', ...context.cptGetTools].join(', ');

  server.registerPrompt(
    'answer_visitor_question',
    {
      title: 'Answer a website visitor',
      description: 'Answers a visitor question using only the site content, with source links.',
      argsSchema: { question: z.string().describe("The visitor's question") },
    },
    ({ question }) =>
      userPrompt(
        `A visitor to the company website asks:\n\n"${question}"\n\n` +
          'Answer using only the website content:\n' +
          '1. Call search_content with the key words of the question. Check both "results" and "acf_matches"; ' +
          'much of the text is stored in ACF fields.\n' +
          `2. Read the most relevant items with ${readTools}. For questions about the company itself, also call get_company_info.\n` +
          '3. If the first search finds nothing, try one or two other phrasings before giving up.\n\n' +
          'Write a short, friendly answer in the language of the question. Link the page URL after each fact. ' +
          "If the site doesn't answer the question, say so plainly and point to the most useful page or contact channel. " +
          "Don't guess or add facts that aren't on the site.",
      ),
  );

  if (context.features.yoast) {
    server.registerPrompt(
      'seo_review',
      {
        title: 'SEO review of one page',
        description: 'Reviews the SEO of one item and proposes specific fixes, most important first.',
        argsSchema: {
          post_type: z.string().describe('Post type slug, e.g. "page" or "project"'),
          slug: z.string().describe('Slug of the item, e.g. "home"'),
        },
      },
      ({ post_type, slug }) =>
        userPrompt(
          `Review the SEO of the ${post_type} with slug "${slug}".\n\n` +
            `1. Call get_seo_meta with post_type "${post_type}" and slug "${slug}".\n` +
            `2. Call get_post with the same post_type and slug to read the content and ACF fields.\n\n` +
            'Then report:\n' +
            '- The problems found, most important first: indexing, title, meta description, social image, image alt text, content gaps.\n' +
            '- For a missing or weak SEO title or meta description, propose new text that fits the page content, ' +
            'with its character count (title about 60 characters at most, description 120–156).\n' +
            '- Alt text suggestions for images that lack it, based on the image captions or context.\n\n' +
            "Only propose changes; don't edit anything.",
        ),
    );
  }

  if (context.profile !== 'editor') {
    return;
  }

  server.registerPrompt(
    'write_blog_draft',
    {
      title: 'Write a blog post draft',
      description: 'Writes a blog post in the style of the existing content and saves it as a draft for review.',
      argsSchema: {
        topic: z.string().describe('What the post is about'),
        tone: z.string().optional().describe('For example "friendly", "expert", "concise"'),
        length: z.string().optional().describe('For example "400 words"'),
      },
    },
    ({ topic, tone, length }) =>
      userPrompt(
        `Write a blog post about: ${topic}\n` +
          `Tone: ${tone ?? 'match the existing site content'}. Length: ${length ?? 'about 600 words'}.\n\n` +
          '1. Call list_posts (post_type "post", per_page 3). If there are posts, read two with get_post to match their style, ' +
          'structure, and terminology. If there are none, read the home page and a few projects instead.\n' +
          '2. Call search_content for the topic, so the post links to related pages on the site.\n' +
          '3. Write the post as HTML (h2/h3 headings, paragraphs, lists; no inline styles) with a 1–2 sentence excerpt. ' +
          'Only state facts that the site supports or that are general knowledge.\n' +
          '4. Save it with create_draft (post_type "post"). Add existing tags with terms only if they fit.\n\n' +
          'Reply with the title, the excerpt, and the preview and edit links. The post stays a draft until a person publishes it.',
      ),
  );

  server.registerPrompt(
    'weekly_content_report',
    {
      title: 'Weekly content report',
      description: 'Summarizes recent content changes, drafts waiting for review, and the top content issues.',
      argsSchema: { days: z.string().optional().describe('How many days to cover (default 7)') },
    },
    ({ days }) => {
      const span = Math.max(1, Math.min(90, Number(days) || 7));
      const since = daysAgo(span);
      return userPrompt(
        `Prepare a content report for the last ${span} days (since ${since}).\n\n` +
          '1. Call list_post_types, then for each type call list_posts with orderby "modified" and modified_after ' +
          `"${since}" to find new or updated items.\n` +
          '2. Call list_drafts for each post type to find drafts and items pending review.\n' +
          '3. Call content_audit for the whole site.\n' +
          (context.features.yoast ? '4. Call find_seo_issues for the whole site.\n' : '') +
          '\nWrite the report with these sections: what changed (with links), waiting for review (with edit links), ' +
          'top 5 problems to fix (with how many items each affects), and one or two suggestions for next week. ' +
          'Keep it short enough to read in two minutes.',
      );
    },
  );
}
