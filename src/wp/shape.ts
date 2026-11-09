import { decodeEntities, htmlToMarkdown, htmlToText, looksLikeHtml, truncate } from './format.js';
import type { WpPost } from './types.js';

/** Note added when a site doesn't expose a post's ACF fields to REST. */
export const ACF_NOT_EXPOSED =
  'No ACF fields in the REST response. Either this post has none, or its field groups ' +
  'do not have "Show in REST API" enabled.';

/** Limits used for ACF values inside list results, to keep many items affordable. */
const COMPACT_MAX_CHARS = 300;
const COMPACT_MAX_ITEMS = 3;

export interface AcfOptions {
  /** Character budget for each text or HTML value. */
  readonly maxChars: number;
  /** Shorten long text and long arrays (repeaters, galleries), for list results. */
  readonly compact: boolean;
}

/** A related post reference produced from ACF relationship / post object fields. */
export interface RelatedPostRef {
  id: number;
  title: string;
  type: string;
  slug: string;
  url?: string;
}

export interface PostSummary {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly slug: string;
  readonly url: string;
  readonly date: string;
  readonly modified: string;
  readonly excerpt?: string;
  readonly acf?: unknown;
}

export function toSummary(post: WpPost, includeAcf: boolean): PostSummary {
  const excerpt = post.excerpt ? htmlToText(post.excerpt.rendered) : '';
  return {
    id: post.id,
    type: post.type,
    title: decodeEntities(post.title.rendered),
    slug: post.slug,
    url: post.link,
    date: post.date,
    modified: post.modified,
    ...(excerpt ? { excerpt: truncate(excerpt, COMPACT_MAX_CHARS) } : {}),
    ...(includeAcf ? { acf: simplifyAcf(post.acf, { maxChars: COMPACT_MAX_CHARS, compact: true }) } : {}),
  };
}

export function toDetail(post: WpPost, maxChars: number, includeAcf: boolean): Record<string, unknown> {
  const embedded = post._embedded ?? {};
  const media = embedded['wp:featuredmedia']?.[0];
  const author = embedded.author?.[0];
  const terms = (embedded['wp:term'] ?? []).flat();

  const termsByTaxonomy: Record<string, string[]> = {};
  for (const term of terms) {
    (termsByTaxonomy[term.taxonomy] ??= []).push(decodeEntities(term.name));
  }

  const body = post.content?.protected ? '' : htmlToMarkdown(post.content?.rendered ?? '');
  const excerpt = post.excerpt ? htmlToText(post.excerpt.rendered) : '';

  return {
    id: post.id,
    type: post.type,
    title: decodeEntities(post.title.rendered),
    slug: post.slug,
    url: post.link,
    date: post.date,
    modified: post.modified,
    ...(author ? { author: author.name } : {}),
    ...(post.parent ? { parent_id: post.parent } : {}),
    ...(post.template ? { template: post.template } : {}),
    ...(media
      ? {
          featured_image: {
            url: media.source_url,
            alt: media.alt_text ?? '',
            width: media.media_details?.width,
            height: media.media_details?.height,
          },
        }
      : {}),
    ...(Object.keys(termsByTaxonomy).length > 0 ? { terms: termsByTaxonomy } : {}),
    ...(excerpt ? { excerpt } : {}),
    content: post.content?.protected ? '[Password protected]' : truncate(body, maxChars),
    ...(includeAcf ? acfSection(post.acf, maxChars) : {}),
  };
}

function acfSection(acf: WpPost['acf'], maxChars: number): Record<string, unknown> {
  const simplified = simplifyAcf(acf, { maxChars, compact: false });
  if (simplified === undefined) {
    return { acf_note: ACF_NOT_EXPOSED };
  }
  return { acf: simplified };
}

/**
 * Makes ACF values (acf_format=standard) compact for the model:
 * HTML becomes Markdown, image arrays shrink to url/alt/size,
 * and related posts shrink to id/title/type/slug.
 */
export function simplifyAcf(
  acf: WpPost['acf'],
  options: AcfOptions = { maxChars: 4000, compact: false },
): Record<string, unknown> | undefined {
  if (!acf || Array.isArray(acf) || Object.keys(acf).length === 0) {
    return undefined;
  }
  return simplifyValue(acf, options) as Record<string, unknown>;
}

function simplifyValue(value: unknown, options: AcfOptions): unknown {
  if (typeof value === 'string') {
    const text = looksLikeHtml(value) ? htmlToMarkdown(value) : value;
    return truncate(text, options.maxChars);
  }
  if (Array.isArray(value)) {
    const items = options.compact ? value.slice(0, COMPACT_MAX_ITEMS) : value;
    const simplified = items.map((item) => simplifyValue(item, options));
    if (value.length > items.length) {
      simplified.push(`[${value.length - items.length} more. Use get_post for the full list.]`);
    }
    return simplified;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const obj = value as Record<string, unknown>;

  // Related post (WP_Post object from relationship / post_object fields).
  if ('ID' in obj && 'post_title' in obj) {
    const ref: RelatedPostRef = {
      id: Number(obj.ID),
      title: decodeEntities(String(obj.post_title)),
      type: String(obj.post_type),
      slug: String(obj.post_name),
    };
    RELATED_REFS.add(ref);
    return ref;
  }

  // Image or file array.
  if ('url' in obj && ('mime_type' in obj || 'sizes' in obj)) {
    return {
      id: obj.ID ?? obj.id,
      url: obj.url,
      alt: obj.alt ?? '',
      ...(obj.width ? { width: obj.width, height: obj.height } : {}),
      ...(obj.caption ? { caption: obj.caption } : {}),
    };
  }

  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(obj)) {
    result[key] = simplifyValue(inner, options);
  }
  return result;
}

/** Tracks objects created as related post refs, so they can be found again without guessing by shape. */
const RELATED_REFS = new WeakSet<object>();

/** Finds every related post reference inside simplified ACF data. */
export function collectRelatedRefs(value: unknown, found: RelatedPostRef[] = []): RelatedPostRef[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRelatedRefs(item, found));
  } else if (value !== null && typeof value === 'object') {
    if (RELATED_REFS.has(value)) {
      found.push(value as RelatedPostRef);
    } else {
      Object.values(value).forEach((inner) => collectRelatedRefs(inner, found));
    }
  }
  return found;
}
