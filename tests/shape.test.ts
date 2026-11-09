import { describe, expect, it } from 'vitest';
import { collectRelatedRefs, simplifyAcf, toDetail, toSummary } from '../src/wp/shape.js';
import type { WpPost } from '../src/wp/types.js';
import { fixture } from './helpers.js';

const home = fixture<WpPost>('home-page-standard.json');
const projects = fixture<WpPost[]>('projects-standard.json');

describe('simplifyAcf', () => {
  it('shrinks relationship values to id, title, type, and slug', () => {
    const acf = simplifyAcf(home.acf)!;
    const portfolio = acf.portfolio as Record<string, unknown>[];
    expect(portfolio.length).toBeGreaterThan(3);
    expect(portfolio[0]).toEqual({ id: 310, title: 'Acme', type: 'project', slug: 'acme' });
  });

  it('shrinks image arrays and converts wysiwyg HTML to Markdown', () => {
    const acme = projects.find((p) => p.id === 310)!;
    const acf = simplifyAcf(acme.acf)!;
    const row = (acf.images as Record<string, Record<string, unknown>>[])[0]!;
    expect(Object.keys(row.image!).sort()).toEqual(['alt', 'height', 'id', 'url', 'width']);
    expect(acf.info).not.toContain('<p>');
    expect(acf.info).toContain('Website for web agency (UK).');
  });

  it('returns undefined when the site exposes no ACF fields', () => {
    expect(simplifyAcf([])).toBeUndefined();
    expect(simplifyAcf({})).toBeUndefined();
    expect(simplifyAcf(undefined)).toBeUndefined();
  });

  it('caps arrays and text in compact mode', () => {
    const acf = simplifyAcf(home.acf, { maxChars: 50, compact: true })!;
    const portfolio = acf.portfolio as unknown[];
    expect(portfolio).toHaveLength(4);
    expect(portfolio[3]).toMatch(/^\[\d+ more\. Use get_post/);
    expect(String(acf.about_content)).toContain('[Truncated:');
  });
});

describe('collectRelatedRefs', () => {
  it('finds the refs created by simplifyAcf, at any depth', () => {
    const acf = simplifyAcf(home.acf);
    const refs = collectRelatedRefs({ wrapper: { acf } });
    expect(refs.map((ref) => ref.slug)).toContain('kubaslabs');
  });

  it('ignores look-alike objects that simplifyAcf did not create', () => {
    expect(collectRelatedRefs({ id: 1, title: 'x', type: 'project', slug: 'x' })).toEqual([]);
  });
});

describe('toSummary and toDetail', () => {
  it('builds a summary with decoded title and optional ACF', () => {
    const post = projects[0]!;
    const summary = toSummary(
      { ...post, date: '2025-12-26T18:04:57', modified: '2025-12-26T18:08:46', slug: 'acme', status: 'publish' },
      false,
    );
    expect(summary).toMatchObject({ id: post.id, type: 'project', url: post.link });
    expect(summary.acf).toBeUndefined();
  });

  it('adds a note instead of ACF when none is exposed', () => {
    const detail = toDetail(
      {
        id: 1,
        date: '',
        modified: '',
        slug: 'a',
        status: 'publish',
        type: 'page',
        link: 'http://aj-ua.local/a/',
        title: { rendered: 'A &amp; B' },
        content: { rendered: '<p>Body</p>' },
        acf: [],
      },
      1000,
      true,
    );
    expect(detail.title).toBe('A & B');
    expect(detail.content).toBe('Body');
    expect(detail.acf_note).toMatch(/Show in REST API/);
  });

  it('hides password-protected content', () => {
    const detail = toDetail(
      {
        id: 2,
        date: '',
        modified: '',
        slug: 'b',
        status: 'publish',
        type: 'page',
        link: '',
        title: { rendered: 'B' },
        content: { rendered: '<p>Secret</p>', protected: true },
      },
      1000,
      false,
    );
    expect(detail.content).toBe('[Password protected]');
  });
});
