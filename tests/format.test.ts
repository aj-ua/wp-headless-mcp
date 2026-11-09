import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToMarkdown, htmlToText, looksLikeHtml, truncate } from '../src/wp/format.js';

describe('decodeEntities', () => {
  it('decodes named, decimal, and hex entities from WordPress titles', () => {
    expect(decodeEntities('Brand &amp; identity')).toBe('Brand & identity');
    expect(decodeEntities('It&#8217;s &#x2014; done')).toBe('It’s — done');
    expect(decodeEntities('&ndash; &hellip; &nbsp;')).toBe('– …  ');
  });

  it('leaves unknown entities alone', () => {
    expect(decodeEntities('&unknown; text')).toBe('&unknown; text');
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings, links, and lists, dropping block comments', () => {
    const html =
      '<!-- wp:heading --><h2>Our work</h2><!-- /wp:heading --><p>See <a href="http://aj-ua.local/project/">projects</a>.</p><ul><li>ACF</li><li>GSAP</li></ul>';
    expect(htmlToMarkdown(html)).toBe(
      '## Our work\n\nSee [projects](http://aj-ua.local/project/).\n\n-   ACF\n-   GSAP',
    );
  });

  it('removes scripts, styles, iframes, and inline SVG', () => {
    const html = '<p>Text</p><script>alert(1)</script><style>p{}</style><iframe src="x"></iframe><svg><path/></svg>';
    expect(htmlToMarkdown(html)).toBe('Text');
  });

  it('returns an empty string for empty content', () => {
    expect(htmlToMarkdown('   ')).toBe('');
  });
});

describe('htmlToText', () => {
  it('strips tags, decodes entities, and collapses whitespace', () => {
    expect(htmlToText('<p>Hello&nbsp;<strong>world</strong></p>\n<p>Again</p>')).toBe('Hello world Again');
  });
});

describe('looksLikeHtml', () => {
  it('tells markup from plain text', () => {
    expect(looksLikeHtml('<p>x</p>')).toBe(true);
    expect(looksLikeHtml('5 < 6 and 7 > 3')).toBe(false);
  });
});

describe('truncate', () => {
  it('keeps short text unchanged', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('cuts at a word boundary and says how much was left out', () => {
    const result = truncate('First sentence. Second sentence. Third one here.', 30);
    expect(result.startsWith('First sentence. Second\n\n')).toBe(true);
    expect(result).toMatch(/\[Truncated: \d+ more characters/);
  });

  it('prefers a sentence end when one is close to the limit', () => {
    const text = 'A'.repeat(70) + '. ' + 'B'.repeat(50);
    expect(truncate(text, 100).startsWith('A'.repeat(70) + '.\n\n')).toBe(true);
  });
});
