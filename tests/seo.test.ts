import { describe, expect, it } from 'vitest';
import { findSeoIssues, toSeoMeta } from '../src/wp/seo.js';

const PAGE = 'http://aj-ua.local/project/acme/';

function codes(head: Parameters<typeof toSeoMeta>[0], url = PAGE): string[] {
  return findSeoIssues(toSeoMeta(head), url).map((issue) => `${issue.severity}:${issue.code}`);
}

describe('toSeoMeta', () => {
  it('normalizes Yoast head data', () => {
    const meta = toSeoMeta({
      title: 'Acme &#8211; AJ Digital Solutions',
      robots: { index: 'index', follow: 'nofollow' },
      og_image: [{ url: 'http://aj-ua.local/wp-content/uploads/2025/12/hero.jpg' }],
      twitter_misc: { 'Est. reading time': '1 minute' },
      schema: { '@graph': [{ '@type': 'WebPage' }, { '@type': ['Organization', 'Brand'] }, { '@type': 'WebPage' }] },
    });
    expect(meta).toMatchObject({
      title: 'Acme – AJ Digital Solutions',
      description: null,
      indexable: true,
      followable: false,
      open_graph: { image: 'http://aj-ua.local/wp-content/uploads/2025/12/hero.jpg' },
      schema_types: ['WebPage', 'Organization', 'Brand'],
      reading_time: '1 minute',
    });
  });
});

describe('findSeoIssues', () => {
  it('passes a healthy page', () => {
    const description =
      'Custom WordPress development and web design services. Building high-performance, SEO-optimized websites tailored to your business needs.';
    expect(
      codes(
        {
          title: 'Home - AJ Digital Solutions',
          description,
          canonical: 'http://aj-ua.local/',
          og_image: [{ url: 'x' }],
        },
        'http://aj-ua.local/',
      ),
    ).toEqual([]);
  });

  it('flags every problem type', () => {
    expect(
      codes({
        title: 'A very long SEO title that keeps going well past the sixty character mark',
        description: 'Too short.',
        robots: { index: 'noindex' },
        canonical: 'http://aj-ua.local/other/',
      }),
    ).toEqual([
      'error:noindex',
      'warning:title_too_long',
      'warning:description_too_short',
      'warning:missing_social_image',
      'warning:canonical_mismatch',
    ]);
    expect(codes({})).toEqual(['error:missing_title', 'warning:missing_description', 'warning:missing_social_image']);
    expect(codes({ title: 'T', description: 'x'.repeat(170), og_image: [{ url: 'x' }] })).toEqual([
      'warning:description_too_long',
    ]);
  });

  it('ignores trailing-slash differences in the canonical URL', () => {
    expect(
      codes({
        title: 'T',
        description: 'x'.repeat(130),
        og_image: [{ url: 'x' }],
        canonical: 'http://aj-ua.local/project/acme',
      }),
    ).toEqual([]);
  });
});
