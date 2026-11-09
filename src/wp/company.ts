import type { WpClient } from './client.js';
import { collectText, type FieldText } from './acf-search.js';
import { detectFeatures } from './features.js';
import { decodeEntities, htmlToText, truncate } from './format.js';
import type { WpPost } from './types.js';

interface WpIndex {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly home: string;
  readonly gmt_offset?: string | number;
  readonly timezone_string?: string;
  readonly site_icon_url?: string;
  readonly namespaces: string[];
}

interface SchemaNode {
  readonly '@type'?: string | string[];
  readonly name?: string;
  readonly url?: string;
  readonly description?: string;
  readonly email?: string;
  readonly telephone?: string;
  readonly sameAs?: string[];
  readonly logo?: { readonly url?: string; readonly contentUrl?: string };
  readonly address?: Record<string, unknown>;
}

export interface CompanyInfo {
  readonly site: {
    readonly name: string;
    readonly tagline: string;
    readonly url: string;
    readonly icon_url?: string;
    readonly timezone: string;
  };
  readonly organization?: {
    readonly type: string;
    readonly name?: string;
    readonly url?: string;
    readonly description?: string;
    readonly logo_url?: string;
    readonly email?: string;
    readonly telephone?: string;
    readonly address?: Record<string, unknown>;
    readonly social_profiles?: string[];
  };
  /** Text of the page shown at the home URL, where company sites usually introduce themselves. */
  readonly home_page?: {
    readonly id: number;
    readonly title: string;
    readonly url: string;
    readonly text: string;
  };
  readonly sources: string[];
  readonly note?: string;
}

/** Enough for an intro paragraph or two without flooding the context. */
const HOME_TEXT_MAX_CHARS = 1500;

const ORGANIZATION_TYPES = new Set(['Organization', 'Corporation', 'LocalBusiness', 'Person']);

/** Site and organization details from the REST index and Yoast's schema graph. */
export class CompanyInfoService {
  public constructor(private readonly wp: WpClient) {}

  public async index(): Promise<WpIndex> {
    return (await this.wp.get<WpIndex>('')).data;
  }

  public async get(): Promise<CompanyInfo> {
    const index = await this.index();
    const sources = ['wp-json index'];

    let organization: CompanyInfo['organization'];
    if (detectFeatures(index.namespaces).yoast) {
      organization = await this.fromYoast(index.home);
      if (organization) {
        sources.push('Yoast SEO schema (Settings > Site representation)');
      }
    }

    const homePage = await this.homePage(index.home);
    if (homePage) {
      sources.push('home page content and ACF fields');
    }

    return {
      site: {
        name: decodeEntities(index.name),
        tagline: decodeEntities(index.description),
        url: index.home,
        ...(index.site_icon_url ? { icon_url: index.site_icon_url } : {}),
        timezone: index.timezone_string || `UTC${formatOffset(index.gmt_offset)}`,
      },
      ...(organization ? { organization } : {}),
      ...(homePage ? { home_page: homePage } : {}),
      sources,
      ...(organization?.email || organization?.telephone
        ? {}
        : {
            note:
              'No email or phone in the public data. Contact details stored in ACF options pages ' +
              'are not available through the REST API; check a contact page with search_content.',
          }),
    };
  }

  /** Finds the page whose permalink is the home URL and returns its body and ACF text. */
  private async homePage(homeUrl: string): Promise<CompanyInfo['home_page']> {
    try {
      const normalize = (url: string): string => url.replace(/\/+$/, '').toLowerCase();
      const res = await this.wp.get<WpPost[]>('wp/v2/pages', {
        per_page: 100,
        orderby: 'menu_order',
        order: 'asc',
        _fields: 'id,link,title,content,acf',
      });
      const page = res.data.find((p) => normalize(p.link) === normalize(homeUrl));
      if (!page) {
        return undefined;
      }

      const parts: FieldText[] = [];
      const body = htmlToText(page.content?.rendered ?? '');
      if (body) {
        parts.push({ path: 'content', text: body });
      }
      collectText(page.acf, '', parts);
      const text = parts.map((part) => part.text).join('\n\n');
      if (!text) {
        return undefined;
      }
      return {
        id: page.id,
        title: decodeEntities(page.title.rendered),
        url: page.link,
        text: truncate(text, HOME_TEXT_MAX_CHARS),
      };
    } catch {
      // A missing or private front page shouldn't break company info.
      return undefined;
    }
  }

  private async fromYoast(homeUrl: string): Promise<CompanyInfo['organization']> {
    try {
      // Yoast answers 404 for the home URL without a trailing slash.
      const res = await this.wp.get<{ json?: { schema?: { '@graph'?: SchemaNode[] } } }>('yoast/v1/get_head', {
        url: homeUrl.endsWith('/') ? homeUrl : `${homeUrl}/`,
      });
      const node = res.data.json?.schema?.['@graph']?.find((n) => {
        const types = Array.isArray(n['@type']) ? n['@type'] : [n['@type']];
        return types.some((t) => t !== undefined && ORGANIZATION_TYPES.has(t));
      });
      if (!node) {
        return undefined;
      }
      const type = Array.isArray(node['@type']) ? node['@type'].join(', ') : (node['@type'] ?? 'Organization');
      return {
        type,
        ...(node.name ? { name: decodeEntities(node.name) } : {}),
        ...(node.url ? { url: node.url } : {}),
        ...(node.description ? { description: node.description } : {}),
        ...(node.logo?.url || node.logo?.contentUrl ? { logo_url: node.logo.url ?? node.logo.contentUrl } : {}),
        ...(node.email ? { email: node.email } : {}),
        ...(node.telephone ? { telephone: node.telephone } : {}),
        ...(node.address ? { address: node.address } : {}),
        ...(node.sameAs?.length ? { social_profiles: node.sameAs } : {}),
      };
    } catch {
      // Yoast data is optional; fall back to the REST index alone.
      return undefined;
    }
  }
}

function formatOffset(offset: string | number | undefined): string {
  const hours = Number(offset ?? 0);
  if (!Number.isFinite(hours) || hours === 0) {
    return '';
  }
  return hours > 0 ? `+${hours}` : String(hours);
}
