import type { WpClient } from './client.js';
import { decodeEntities, htmlToText } from './format.js';
import type { SiteModel } from './site-model.js';
import type { WpPost } from './types.js';

/** Upper bound on items scanned per post type, so one search stays affordable on big sites. */
const MAX_ITEMS_PER_TYPE = 500;
const PAGE_SIZE = 100;
const SNIPPET_RADIUS = 80;

export interface AcfSearchHit {
  readonly id: number;
  readonly post_type: string;
  readonly title: string;
  readonly url: string;
  /** Field path where the best match was found, e.g. "about_content" or "images.1.desc". */
  readonly field: string;
  readonly snippet: string;
}

export interface AcfSearchResult {
  readonly hits: AcfSearchHit[];
  readonly scanned: Record<string, number>;
  /** True when a post type had more items than were scanned. */
  readonly truncated: boolean;
}

export interface FieldText {
  readonly path: string;
  readonly text: string;
}

/** Collects every non-empty text value in ACF data, with its field path. */
export function collectText(value: unknown, path: string, out: FieldText[]): void {
  if (typeof value === 'string') {
    const text = htmlToText(value);
    if (text !== '') {
      out.push({ path, text });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectText(item, `${path}.${i}`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      collectText(inner, path ? `${path}.${key}` : key, out);
    }
  }
}

/** Lowercased search words; very short words are ignored because they match almost everything. */
export function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length >= 2),
    ),
  ];
}

function snippetAround(text: string, term: string): string {
  const index = text.toLowerCase().indexOf(term);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + term.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Searches ACF field values, which WordPress's own search (/wp/v2/search) ignores.
 * A post matches when every search word appears somewhere in its ACF text.
 */
export class AcfSearch {
  public constructor(
    private readonly wp: WpClient,
    private readonly site: SiteModel,
  ) {}

  public async search(query: string, postType?: string): Promise<AcfSearchResult> {
    const terms = searchTerms(query);
    if (terms.length === 0) {
      return { hits: [], scanned: {}, truncated: false };
    }

    const types = (await this.site.postTypes()).filter((type) => !postType || type.slug === postType);
    const scanned: Record<string, number> = {};
    const scored: { hit: AcfSearchHit; score: number }[] = [];
    let truncated = false;

    for (const type of types) {
      const posts = await this.loadPosts(`${type.rest_namespace}/${type.rest_base}`);
      scanned[type.slug] = posts.items.length;
      truncated ||= posts.truncated;

      for (const post of posts.items) {
        const fields: FieldText[] = [];
        collectText(post.acf, '', fields);
        if (fields.length === 0) {
          continue;
        }

        const combined = fields.map((field) => field.text.toLowerCase()).join('\n');
        if (!terms.every((term) => combined.includes(term))) {
          continue;
        }

        // The field holding the most search words gives the snippet.
        let best = fields[0]!;
        let bestCount = -1;
        for (const field of fields) {
          const lower = field.text.toLowerCase();
          const count = terms.filter((term) => lower.includes(term)).length;
          if (count > bestCount) {
            best = field;
            bestCount = count;
          }
        }
        const firstTerm = terms.find((term) => best.text.toLowerCase().includes(term)) ?? terms[0]!;
        const occurrences = terms.reduce((sum, term) => sum + combined.split(term).length - 1, 0);

        scored.push({
          score: bestCount * 100 + occurrences,
          hit: {
            id: post.id,
            post_type: post.type,
            title: decodeEntities(post.title.rendered),
            url: post.link,
            field: best.path,
            snippet: snippetAround(best.text, firstTerm),
          },
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return { hits: scored.map((entry) => entry.hit), scanned, truncated };
  }

  /** Published items of one type with raw ACF values. Cached by WpClient for the cache lifetime. */
  private async loadPosts(route: string): Promise<{ items: WpPost[]; truncated: boolean }> {
    const items: WpPost[] = [];
    for (let page = 1; items.length < MAX_ITEMS_PER_TYPE; page += 1) {
      const res = await this.wp.get<WpPost[]>(route, {
        per_page: PAGE_SIZE,
        page,
        _fields: 'id,type,link,title,acf',
      });
      items.push(...res.data);
      if (page >= (res.totalPages ?? 1) || res.data.length === 0) {
        return { items, truncated: false };
      }
    }
    return { items: items.slice(0, MAX_ITEMS_PER_TYPE), truncated: true };
  }
}
