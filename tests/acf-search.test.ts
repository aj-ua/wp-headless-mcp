import { describe, expect, it } from 'vitest';
import { AcfSearch, searchTerms } from '../src/wp/acf-search.js';
import { SiteModel } from '../src/wp/site-model.js';
import { fakeWp, fixture } from './helpers.js';

const home = fixture<Record<string, unknown>>('home-page-standard.json');
const projects = fixture<Record<string, unknown>[]>('projects-standard.json');

function search(): AcfSearch {
  const { wp } = fakeWp({ 'wp/v2/posts': [], 'wp/v2/pages': [home], 'wp/v2/project': projects });
  return new AcfSearch(wp, new SiteModel(wp));
}

describe('searchTerms', () => {
  it('lowercases, deduplicates, and drops one-letter words', () => {
    expect(searchTerms('GSAP a gsap WPML')).toEqual(['gsap', 'wpml']);
  });
});

describe('AcfSearch', () => {
  it('finds text that only exists in ACF fields', async () => {
    const result = await search().search('Andrii');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ id: 4, post_type: 'page', field: 'about_content' });
    expect(result.hits[0]!.snippet).toContain('My name is Andrii');
  });

  it('requires every search word to match', async () => {
    const result = await search().search('GSAP WPML');
    expect(result.hits.map((hit) => hit.title)).toEqual(['Kubaslabs']);
  });

  it('limits the search to one post type', async () => {
    const result = await search().search('website', 'page');
    expect(result.hits.every((hit) => hit.post_type === 'page')).toBe(true);
    expect(Object.keys(result.scanned)).toEqual(['page']);
  });

  it('reports scanned counts and never includes the media library', async () => {
    const result = await search().search('nothing-matches-this');
    expect(result.hits).toEqual([]);
    expect(result.scanned).toEqual({ post: 0, page: 1, project: projects.length });
  });

  it('returns nothing for a query of only short words', async () => {
    expect((await search().search('a b')).hits).toEqual([]);
  });
});
