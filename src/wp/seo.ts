import { decodeEntities } from './format.js';

/** The parts of Yoast's yoast_head_json used here. */
export interface YoastHeadJson {
  readonly title?: string;
  readonly description?: string;
  readonly robots?: Record<string, string>;
  readonly canonical?: string;
  readonly og_type?: string;
  readonly og_title?: string;
  readonly og_description?: string;
  readonly og_url?: string;
  readonly og_image?: { readonly url: string; readonly width?: number; readonly height?: number }[];
  readonly twitter_card?: string;
  readonly twitter_title?: string;
  readonly twitter_description?: string;
  readonly twitter_image?: string;
  readonly twitter_misc?: Record<string, string>;
  readonly article_modified_time?: string;
  readonly schema?: { readonly '@graph'?: { readonly '@type'?: string | string[] }[] };
}

export interface SeoMeta {
  readonly title: string | null;
  readonly description: string | null;
  readonly canonical: string | null;
  readonly indexable: boolean;
  readonly followable: boolean;
  readonly open_graph: {
    readonly type?: string;
    readonly title?: string;
    readonly description?: string;
    readonly image?: string;
  };
  readonly twitter: {
    readonly card?: string;
    readonly title?: string;
    readonly description?: string;
    readonly image?: string;
  };
  readonly schema_types: string[];
  readonly reading_time?: string;
}

export interface SeoIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
}

/**
 * Thresholds follow Yoast's own guidance. Yoast measures titles in pixels (about 600px);
 * 60 characters is the common approximation.
 */
const TITLE_MAX_CHARS = 60;
const DESCRIPTION_MIN_CHARS = 120;
const DESCRIPTION_MAX_CHARS = 156;

export function toSeoMeta(head: YoastHeadJson): SeoMeta {
  const robots = head.robots ?? {};
  const schemaTypes = (head.schema?.['@graph'] ?? []).flatMap((node) => {
    const type = node['@type'];
    return Array.isArray(type) ? type : type ? [type] : [];
  });

  return {
    title: head.title ? decodeEntities(head.title) : null,
    description: head.description ? decodeEntities(head.description) : null,
    canonical: head.canonical ?? null,
    indexable: robots.index !== 'noindex',
    followable: robots.follow !== 'nofollow',
    open_graph: {
      ...(head.og_type ? { type: head.og_type } : {}),
      ...(head.og_title ? { title: decodeEntities(head.og_title) } : {}),
      ...(head.og_description ? { description: decodeEntities(head.og_description) } : {}),
      ...(head.og_image?.[0]?.url ? { image: head.og_image[0].url } : {}),
    },
    twitter: {
      ...(head.twitter_card ? { card: head.twitter_card } : {}),
      ...(head.twitter_title ? { title: decodeEntities(head.twitter_title) } : {}),
      ...(head.twitter_description ? { description: decodeEntities(head.twitter_description) } : {}),
      ...(head.twitter_image ? { image: head.twitter_image } : {}),
    },
    schema_types: [...new Set(schemaTypes)],
    ...(head.twitter_misc?.['Est. reading time'] ? { reading_time: head.twitter_misc['Est. reading time'] } : {}),
  };
}

/** Normalizes URLs so "http://site/a" and "http://site/a/" compare as equal. */
function sameUrl(a: string, b: string): boolean {
  const normalize = (url: string): string => url.replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

/** Checks a page's SEO metadata against common Yoast recommendations. */
export function findSeoIssues(meta: SeoMeta, pageUrl: string | undefined): SeoIssue[] {
  const issues: SeoIssue[] = [];

  if (!meta.indexable) {
    issues.push({
      severity: 'error',
      code: 'noindex',
      message: 'Page is set to noindex, so search engines will not show it.',
    });
  }

  if (!meta.title) {
    issues.push({ severity: 'error', code: 'missing_title', message: 'No SEO title.' });
  } else if (meta.title.length > TITLE_MAX_CHARS) {
    issues.push({
      severity: 'warning',
      code: 'title_too_long',
      message: `SEO title is ${meta.title.length} characters; over about ${TITLE_MAX_CHARS} may be cut off in search results.`,
    });
  }

  if (!meta.description) {
    issues.push({
      severity: 'warning',
      code: 'missing_description',
      message: 'No meta description. Search engines will pick a snippet from the page instead.',
    });
  } else if (meta.description.length < DESCRIPTION_MIN_CHARS) {
    issues.push({
      severity: 'warning',
      code: 'description_too_short',
      message: `Meta description is ${meta.description.length} characters; aim for ${DESCRIPTION_MIN_CHARS}–${DESCRIPTION_MAX_CHARS}.`,
    });
  } else if (meta.description.length > DESCRIPTION_MAX_CHARS) {
    issues.push({
      severity: 'warning',
      code: 'description_too_long',
      message: `Meta description is ${meta.description.length} characters; over ${DESCRIPTION_MAX_CHARS} may be cut off.`,
    });
  }

  if (!meta.open_graph.image) {
    issues.push({
      severity: 'warning',
      code: 'missing_social_image',
      message: 'No social sharing image (Open Graph). Set a featured image or a Yoast social image.',
    });
  }

  if (meta.canonical && pageUrl && !sameUrl(meta.canonical, pageUrl)) {
    issues.push({
      severity: 'warning',
      code: 'canonical_mismatch',
      message: `Canonical URL (${meta.canonical}) differs from the page URL (${pageUrl}).`,
    });
  }

  return issues;
}
