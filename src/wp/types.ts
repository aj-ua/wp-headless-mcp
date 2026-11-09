/** Subset of WordPress REST API response shapes used by the tools. */

export interface WpRendered {
  readonly rendered: string;
  readonly protected?: boolean;
}

export interface WpEmbeddedMedia {
  readonly id: number;
  readonly source_url: string;
  readonly alt_text?: string;
  readonly media_type?: string;
  readonly caption?: WpRendered;
  readonly media_details?: { readonly width?: number; readonly height?: number };
}

export interface WpEmbeddedTerm {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly taxonomy: string;
}

export interface WpEmbeddedAuthor {
  readonly id: number;
  readonly name: string;
}

export interface WpPost {
  readonly id: number;
  readonly date: string;
  readonly modified: string;
  readonly slug: string;
  readonly status: string;
  readonly type: string;
  readonly link: string;
  readonly title: WpRendered;
  readonly content?: WpRendered;
  readonly excerpt?: WpRendered;
  readonly parent?: number;
  readonly menu_order?: number;
  readonly template?: string;
  readonly featured_media?: number;
  readonly acf?: Record<string, unknown> | unknown[];
  readonly _embedded?: {
    readonly author?: WpEmbeddedAuthor[];
    readonly 'wp:featuredmedia'?: WpEmbeddedMedia[];
    readonly 'wp:term'?: WpEmbeddedTerm[][];
  };
}

export interface WpType {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly hierarchical: boolean;
  readonly taxonomies: string[];
  readonly rest_base: string;
  readonly rest_namespace: string;
}

export interface WpTaxonomy {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly hierarchical: boolean;
  readonly types: string[];
  readonly rest_base: string;
  readonly rest_namespace: string;
}

export interface WpTerm {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly count: number;
  readonly parent?: number;
  readonly link: string;
  readonly taxonomy: string;
}
