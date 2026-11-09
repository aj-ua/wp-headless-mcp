import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from '../src/config.js';
import type { QueryValue, WpClient, WpResponse } from '../src/wp/client.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const ACF_JSON_DIR = join(FIXTURES, 'acf-json');

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ WP_URL: 'http://aj-ua.local', ...env });
}

/** Minimal /wp/v2/types and /wp/v2/taxonomies responses matching aj-ua. */
export const TYPES = {
  post: {
    slug: 'post',
    name: 'Posts',
    description: '',
    hierarchical: false,
    taxonomies: ['category', 'post_tag'],
    rest_base: 'posts',
    rest_namespace: 'wp/v2',
  },
  page: {
    slug: 'page',
    name: 'Pages',
    description: '',
    hierarchical: true,
    taxonomies: [],
    rest_base: 'pages',
    rest_namespace: 'wp/v2',
  },
  attachment: {
    slug: 'attachment',
    name: 'Media',
    description: '',
    hierarchical: false,
    taxonomies: [],
    rest_base: 'media',
    rest_namespace: 'wp/v2',
  },
  project: {
    slug: 'project',
    name: 'Projects',
    description: '',
    hierarchical: false,
    taxonomies: [],
    rest_base: 'project',
    rest_namespace: 'wp/v2',
  },
};

export const TAXONOMIES = {
  category: {
    slug: 'category',
    name: 'Categories',
    description: '',
    hierarchical: true,
    types: ['post'],
    rest_base: 'categories',
    rest_namespace: 'wp/v2',
  },
  post_tag: {
    slug: 'post_tag',
    name: 'Tags',
    description: '',
    hierarchical: false,
    types: ['post'],
    rest_base: 'tags',
    rest_namespace: 'wp/v2',
  },
};

type Handler = (query: Record<string, QueryValue>) => unknown;

/**
 * A fake WpClient answering GET requests from a route → handler map.
 * Records every call, so tests can check which requests were made.
 */
export function fakeWp(routes: Record<string, unknown>): {
  wp: WpClient;
  calls: { route: string; query: Record<string, QueryValue> }[];
} {
  const calls: { route: string; query: Record<string, QueryValue> }[] = [];
  const all: Record<string, unknown> = { 'wp/v2/types': TYPES, 'wp/v2/taxonomies': TAXONOMIES, ...routes };

  const respond = <T>(route: string, query: Record<string, QueryValue>): WpResponse<T> => {
    calls.push({ route, query });
    if (!(route in all)) {
      throw new Error(`fakeWp: no handler for route "${route}"`);
    }
    const handler = all[route];
    const data = typeof handler === 'function' ? (handler as Handler)(query) : handler;
    const total = Array.isArray(data) ? data.length : undefined;
    return { data: data as T, total, totalPages: total === undefined ? undefined : 1 };
  };

  const wp = {
    siteUrl: 'http://aj-ua.local',
    isAuthenticated: false,
    username: undefined,
    get: <T>(route: string, query: Record<string, QueryValue> = {}) => Promise.resolve(respond<T>(route, query)),
    options: <T>(route: string) => Promise.resolve(respond<T>(`OPTIONS ${route}`, {})),
  };
  return { wp: wp as unknown as WpClient, calls };
}
