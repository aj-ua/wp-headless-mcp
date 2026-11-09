import TurndownService from 'turndown';

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/**
 * Decodes HTML entities that WordPress adds to rendered titles,
 * e.g. "Brand &amp; identity" or "It&#8217;s".
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) {
      return String.fromCodePoint(parseInt(entity.slice(1), 10));
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
});
turndown.remove(['script', 'style', 'noscript', 'form', 'button', 'iframe']);
// Inline SVG icons add noise; the tag isn't in the HTML element map, so match by node name.
turndown.remove((node) => node.nodeName.toLowerCase() === 'svg');

/** Converts rendered post HTML to compact Markdown. */
export function htmlToMarkdown(html: string): string {
  if (html.trim() === '') {
    return '';
  }
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  return turndown
    .turndown(withoutComments)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Converts rendered HTML (e.g. an excerpt) to a single line of plain text. */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when a string looks like HTML markup rather than plain text. */
export function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*?>/i.test(value);
}

/** Cuts text to a character budget and says how much was left out. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const cut = text.slice(0, maxChars);
  // Prefer ending at a paragraph or sentence; otherwise at a word boundary.
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  const lastSpace = cut.lastIndexOf(' ');
  let kept = cut;
  if (lastBreak > maxChars * 0.6) {
    kept = cut.slice(0, lastBreak + 1);
  } else if (lastSpace > 0) {
    kept = cut.slice(0, lastSpace);
  }
  return `${kept.trimEnd()}\n\n[Truncated: ${text.length - kept.length} more characters. Raise max_chars to see more.]`;
}
