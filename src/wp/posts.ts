import { WpApiError, type WpClient } from './client.js';
import { collectRelatedRefs, toDetail, toSummary, type PostSummary } from './shape.js';
import type { SiteModel } from './site-model.js';
import type { WpPost, WpTerm } from './types.js';

const SUMMARY_FIELDS = 'id,date,modified,slug,status,type,link,title,excerpt';
const DETAIL_FIELDS =
  'id,date,modified,slug,status,type,link,title,content,excerpt,parent,template,featured_media,acf,_links,_embedded';
const DETAIL_EMBED = 'author,wp:featuredmedia,wp:term';

export interface ListPostsOptions {
  readonly postType: string;
  readonly search?: string;
  readonly taxonomy?: string;
  readonly terms?: string[];
  readonly after?: string;
  readonly before?: string;
  readonly modifiedAfter?: string;
  readonly orderby: 'date' | 'modified' | 'title' | 'menu_order' | 'relevance';
  readonly order: 'asc' | 'desc';
  readonly includeAcf: boolean;
  readonly perPage: number;
  readonly page: number;
}

export interface ListPostsResult {
  readonly post_type: string;
  readonly total: number;
  readonly total_pages: number | undefined;
  readonly page: number;
  readonly items: PostSummary[];
}

export interface GetPostOptions {
  readonly postType: string;
  readonly id?: number;
  readonly slug?: string;
  readonly includeAcf: boolean;
  readonly maxChars: number;
}

/** An item as stored (raw values), used to copy or check posts before writing. */
export interface EditablePost {
  readonly id: number;
  readonly type: string;
  readonly status: string;
  readonly link: string;
  readonly slug: string;
  readonly title: string;
  readonly content: string;
  readonly excerpt: string;
  readonly template: string;
  readonly featuredMedia: number;
  /** ACF values in REST's default ("light") format: IDs for images and related posts, ready to write back. */
  readonly acf: Record<string, unknown>;
  /** Term IDs keyed by taxonomy REST field, e.g. { categories: [3] }. */
  readonly terms: Record<string, number[]>;
}

/** Accepts "2024-05-01" or a full ISO 8601 datetime, as WordPress expects. */
function toWpDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
}

/** Shared read logic behind the generic content tools, CPT tools, and resources. */
export class PostService {
  public constructor(
    private readonly wp: WpClient,
    private readonly site: SiteModel,
  ) {}

  public async list(options: ListPostsOptions): Promise<ListPostsResult> {
    if (options.orderby === 'relevance' && !options.search) {
      throw new Error('orderby "relevance" requires a search term.');
    }
    if (options.terms?.length && !options.taxonomy) {
      throw new Error('terms requires taxonomy.');
    }

    const route = await this.site.postTypeRoute(options.postType);
    const query: Record<string, string | number | undefined> = {
      search: options.search,
      after: toWpDate(options.after),
      before: toWpDate(options.before),
      modified_after: toWpDate(options.modifiedAfter),
      orderby: options.orderby,
      order: options.order,
      per_page: options.perPage,
      page: options.page,
      _fields: options.includeAcf ? `${SUMMARY_FIELDS},acf` : SUMMARY_FIELDS,
      acf_format: options.includeAcf ? 'standard' : undefined,
    };

    if (options.taxonomy && options.terms?.length) {
      const tax = await this.site.taxonomyRoute(options.taxonomy);
      query[tax.queryParam] = (await this.resolveTermIds(tax.route, options.terms)).join(',');
    }

    const res = await this.wp.get<WpPost[]>(route, query);
    const items = res.data.map((post) => toSummary(post, options.includeAcf));
    await this.addRelatedUrls(items);

    return {
      post_type: options.postType,
      total: res.total ?? res.data.length,
      total_pages: res.totalPages,
      page: options.page,
      items,
    };
  }

  /** Returns the raw REST post, for callers that need fields like template. */
  public async getRaw(options: Omit<GetPostOptions, 'maxChars'>): Promise<WpPost> {
    if (options.id === undefined && options.slug === undefined) {
      throw new Error('Provide either id or slug.');
    }

    const route = await this.site.postTypeRoute(options.postType);
    const query = {
      _embed: DETAIL_EMBED,
      _fields: DETAIL_FIELDS,
      acf_format: options.includeAcf ? 'standard' : undefined,
    };

    const notFound = new Error(
      `No published ${options.postType} found with ${options.id !== undefined ? `ID ${options.id}` : `slug "${options.slug}"`}.`,
    );

    let post: WpPost | undefined;
    try {
      post =
        options.id !== undefined
          ? (await this.wp.get<WpPost>(`${route}/${options.id}`, query)).data
          : (await this.wp.get<WpPost[]>(route, { ...query, slug: options.slug })).data[0];
    } catch (error) {
      // 401/403 means the item exists but isn't public (a draft or private post).
      // Report it like a missing item, so unpublished content isn't revealed.
      if (error instanceof WpApiError && [401, 403, 404].includes(error.status)) {
        throw notFound;
      }
      throw error;
    }

    if (!post) {
      throw notFound;
    }
    return post;
  }

  public async get(options: GetPostOptions): Promise<Record<string, unknown>> {
    const post = await this.getRaw(options);
    const detail = toDetail(post, options.maxChars, options.includeAcf);
    await this.addRelatedUrls(detail);
    return detail;
  }

  /**
   * ACF relationship values carry the related post's slug but not its URL.
   * Looks the URLs up in one request per post type and fills them in.
   */
  public async addRelatedUrls(data: unknown): Promise<void> {
    const refs = collectRelatedRefs(data);
    if (refs.length === 0) {
      return;
    }

    const idsByType = new Map<string, Set<number>>();
    for (const ref of refs) {
      let ids = idsByType.get(ref.type);
      if (!ids) {
        ids = new Set();
        idsByType.set(ref.type, ids);
      }
      ids.add(ref.id);
    }

    const urls = new Map<string, string>();
    await Promise.all(
      [...idsByType].map(async ([type, ids]) => {
        try {
          const route = await this.site.postTypeRoute(type);
          const res = await this.wp.get<Pick<WpPost, 'id' | 'link'>[]>(route, {
            include: [...ids].join(','),
            per_page: 100,
            _fields: 'id,link',
          });
          res.data.forEach((post) => urls.set(`${type}:${post.id}`, post.link));
        } catch {
          // The related type may not be in REST; leave those refs without a URL.
        }
      }),
    );

    for (const ref of refs) {
      const url = urls.get(`${ref.type}:${ref.id}`);
      if (url) {
        ref.url = url;
      }
    }
  }

  /**
   * Resolves term slugs or IDs per taxonomy into the REST field names used when writing,
   * e.g. { category: ["news"] } → { categories: [3] }.
   */
  public async termFields(terms: Record<string, string[]>): Promise<Record<string, number[]>> {
    const fields: Record<string, number[]> = {};
    for (const [taxonomy, values] of Object.entries(terms)) {
      const tax = await this.site.taxonomyRoute(taxonomy);
      fields[tax.queryParam] = await this.resolveTermIds(tax.route, values);
    }
    return fields;
  }

  /** Reads an item in "edit" context (raw title/content, status, raw ACF values). Needs auth. */
  public async getForEdit(postType: string, id: number): Promise<EditablePost> {
    const route = await this.site.postTypeRoute(postType);
    const type = (await this.site.postTypes()).find((t) => t.slug === postType || t.rest_base === postType);
    const taxonomies = await this.site.taxonomies();
    const termFields = (type?.taxonomies ?? [])
      .map((slug) => taxonomies.find((tax) => tax.slug === slug)?.rest_base)
      .filter((field): field is string => field !== undefined);

    const res = await this.wp.get<Record<string, unknown>>(`${route}/${id}`, {
      context: 'edit',
      _fields: [
        'id',
        'type',
        'status',
        'link',
        'slug',
        'title',
        'content',
        'excerpt',
        'template',
        'featured_media',
        'acf',
        ...termFields,
      ].join(','),
    });
    const raw = res.data;
    const rawText = (value: unknown): string => (value as { raw?: string } | undefined)?.raw ?? '';

    return {
      id: Number(raw.id),
      type: String(raw.type),
      status: String(raw.status),
      link: String(raw.link),
      slug: typeof raw.slug === 'string' ? raw.slug : '',
      title: rawText(raw.title),
      content: rawText(raw.content),
      excerpt: rawText(raw.excerpt),
      template: typeof raw.template === 'string' ? raw.template : '',
      featuredMedia: Number(raw.featured_media ?? 0),
      acf: raw.acf && !Array.isArray(raw.acf) ? (raw.acf as Record<string, unknown>) : {},
      terms: Object.fromEntries(termFields.map((field) => [field, (raw[field] as number[] | undefined) ?? []])),
    };
  }

  /** Turns term slugs into IDs, which is what post collection filters expect. */
  private async resolveTermIds(taxonomyRoute: string, terms: string[]): Promise<number[]> {
    const ids = terms.filter((t) => /^\d+$/.test(t)).map(Number);
    const slugs = terms.filter((t) => !/^\d+$/.test(t));

    if (slugs.length > 0) {
      const res = await this.wp.get<Pick<WpTerm, 'id' | 'slug'>[]>(taxonomyRoute, {
        slug: slugs.join(','),
        per_page: 100,
        _fields: 'id,slug',
      });
      const missing = slugs.filter((slug) => !res.data.some((term) => term.slug === slug));
      if (missing.length > 0) {
        throw new Error(`Unknown term slug(s): ${missing.join(', ')}. Use list_terms to see valid slugs.`);
      }
      ids.push(...res.data.map((term) => term.id));
    }

    return ids;
  }
}
