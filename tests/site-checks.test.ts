import { describe, expect, it } from 'vitest';
import { sitemapPostTypes } from '../src/tools/dev.js';
import { detectFeatures } from '../src/wp/features.js';

describe('sitemapPostTypes', () => {
  it('reads post types from a Yoast sitemap index, skipping taxonomies and authors', () => {
    const xml = ['page', 'project', 'service2', 'category', 'author']
      .map(
        (name) =>
          `<sitemap><loc>http://aj-ua.local/${name.replace(/\d$/, '')}-sitemap${name.match(/\d$/)?.[0] ?? ''}.xml</loc></sitemap>`,
      )
      .join('');
    expect(sitemapPostTypes(`<sitemapindex>${xml}</sitemapindex>`)).toEqual(['page', 'project', 'service']);
  });

  it('reads post types from the core WordPress sitemap, skipping taxonomies and users', () => {
    const xml = [
      'wp-sitemap-posts-post-1.xml',
      'wp-sitemap-posts-case-study-1.xml',
      'wp-sitemap-taxonomies-category-1.xml',
      'wp-sitemap-users-1.xml',
    ]
      .map((file) => `<sitemap><loc>http://aj-ua.local/${file}</loc></sitemap>`)
      .join('');
    expect(sitemapPostTypes(xml)).toEqual(['post', 'case-study']);
  });
});

describe('detectFeatures', () => {
  it('detects optional plugins from REST namespaces', () => {
    expect(detectFeatures(['wp/v2', 'yoast/v1', 'gf/v2'])).toEqual({
      yoast: true,
      gravityForms: true,
      abilities: false,
    });
    expect(detectFeatures(['wp/v2', 'wp-abilities/v1'])).toEqual({
      yoast: false,
      gravityForms: false,
      abilities: true,
    });
  });
});
