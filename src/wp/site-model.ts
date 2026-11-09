import type { WpClient } from './client.js';
import type { WpTaxonomy, WpType } from './types.js';

/** Post types that hold site content (not media, menus, or block editor internals). */
const NON_CONTENT_TYPES = new Set(['attachment', 'nav_menu_item']);
const NON_CONTENT_TAXONOMIES = new Set(['nav_menu']);

/*
 * Note: these two endpoints return objects keyed by slug, and `_fields`
 * filters those top-level keys instead of each type's fields. So the full
 * response is fetched (small, and cached by WpClient).
 */

/**
 * Resolves post types and taxonomies to their REST routes,
 * so tools never hardcode paths like /wp/v2/project.
 * Relies on the WpClient GET cache, so it stays fresh within the cache TTL.
 */
export class SiteModel {
  public constructor(private readonly wp: WpClient) {}

  public async postTypes(): Promise<WpType[]> {
    const res = await this.wp.get<Record<string, WpType>>('wp/v2/types');
    return Object.values(res.data).filter(
      (type) => !NON_CONTENT_TYPES.has(type.slug) && !type.slug.startsWith('wp_') && type.rest_base !== '',
    );
  }

  public async taxonomies(): Promise<WpTaxonomy[]> {
    const res = await this.wp.get<Record<string, WpTaxonomy>>('wp/v2/taxonomies');
    return Object.values(res.data).filter(
      (tax) => !NON_CONTENT_TAXONOMIES.has(tax.slug) && !tax.slug.startsWith('wp_'),
    );
  }

  /** Returns the REST route for a post type slug, e.g. "project" → "wp/v2/project". */
  public async postTypeRoute(slug: string): Promise<string> {
    const types = await this.postTypes();
    const type = types.find((t) => t.slug === slug || t.rest_base === slug);
    if (!type) {
      throw new Error(`Unknown post type "${slug}". Available post types: ${types.map((t) => t.slug).join(', ')}.`);
    }
    return `${type.rest_namespace}/${type.rest_base}`;
  }

  /** Returns the REST route and the posts-collection query parameter for a taxonomy. */
  public async taxonomyRoute(slug: string): Promise<{ route: string; queryParam: string }> {
    const taxonomies = await this.taxonomies();
    const tax = taxonomies.find((t) => t.slug === slug || t.rest_base === slug);
    if (!tax) {
      throw new Error(`Unknown taxonomy "${slug}". Available taxonomies: ${taxonomies.map((t) => t.slug).join(', ')}.`);
    }
    return { route: `${tax.rest_namespace}/${tax.rest_base}`, queryParam: tax.rest_base };
  }
}
