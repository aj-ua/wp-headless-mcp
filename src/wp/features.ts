import type { WpClient } from './client.js';

/** Optional plugins and APIs detected from the REST index's namespaces. */
export interface SiteFeatures {
  readonly yoast: boolean;
  readonly gravityForms: boolean;
  readonly abilities: boolean;
}

export function detectFeatures(namespaces: readonly string[]): SiteFeatures {
  return {
    yoast: namespaces.includes('yoast/v1'),
    gravityForms: namespaces.includes('gf/v2'),
    abilities: namespaces.includes('wp-abilities/v1'),
  };
}

/** Reads the REST index and detects features; used at startup to decide which tools to register. */
export async function loadFeatures(wp: WpClient): Promise<SiteFeatures> {
  const res = await wp.get<{ namespaces?: string[] }>('');
  return detectFeatures(res.data.namespaces ?? []);
}
