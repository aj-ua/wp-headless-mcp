import { afterEach, describe, expect, it, vi } from 'vitest';
import { WpApiError, WpClient } from '../src/wp/client.js';
import { testConfig } from './helpers.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: string | URL, init: RequestInit = {}) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WpClient.get', () => {
  it('builds /wp-json URLs, drops empty query values, and reads pagination headers', async () => {
    const fetch = mockFetch(() =>
      jsonResponse([{ id: 1 }], { headers: { 'X-WP-Total': '18', 'X-WP-TotalPages': '9' } }),
    );
    const res = await new WpClient(testConfig()).get('wp/v2/project', { per_page: 2, search: '', page: undefined });

    expect(fetch.mock.calls[0]![0]).toBe('http://aj-ua.local/wp-json/wp/v2/project?per_page=2');
    expect(res).toEqual({ data: [{ id: 1 }], total: 18, totalPages: 9 });
  });

  it('caches GET responses for the cache lifetime', async () => {
    const fetch = mockFetch(() => jsonResponse({ ok: true }));
    const wp = new WpClient(testConfig());
    await wp.get('wp/v2/types');
    await wp.get('wp/v2/types');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache when WP_CACHE_TTL is 0', async () => {
    const fetch = mockFetch(() => jsonResponse({ ok: true }));
    const wp = new WpClient(testConfig({ WP_CACHE_TTL: '0' }));
    await wp.get('wp/v2/types');
    await wp.get('wp/v2/types');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('turns WordPress error bodies into WpApiError', async () => {
    mockFetch(() =>
      jsonResponse({ code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.' }, { status: 401 }),
    );
    const error = await new WpClient(testConfig()).get('wp/v2/project/324').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WpApiError);
    expect(error).toMatchObject({ status: 401, code: 'rest_forbidden' });
  });

  it('sends Basic auth only when credentials are set', async () => {
    const fetch = mockFetch(() => jsonResponse({}));
    await new WpClient(testConfig()).get('a');
    await new WpClient(testConfig({ WP_USER: 'mcp-editor', WP_APP_PASSWORD: 'abcd efgh' })).get('b');

    const headers = (call: number): Record<string, string> =>
      fetch.mock.calls[call]![1].headers as Record<string, string>;
    expect(headers(0).Authorization).toBeUndefined();
    expect(headers(1).Authorization).toBe(`Basic ${Buffer.from('mcp-editor:abcd efgh').toString('base64')}`);
  });
});

describe('WpClient writes', () => {
  it('refuses to write without credentials', async () => {
    await expect(new WpClient(testConfig()).post('wp/v2/posts', {})).rejects.toThrow(/WP_USER and WP_APP_PASSWORD/);
  });

  it('clears the cache after a write', async () => {
    let title = 'old';
    const fetch = mockFetch((_url, init) => {
      if (init.method === 'POST') {
        title = 'new';
      }
      return jsonResponse({ title });
    });
    const wp = new WpClient(testConfig({ WP_USER: 'u', WP_APP_PASSWORD: 'p' }));

    expect((await wp.get<{ title: string }>('wp/v2/posts/1')).data.title).toBe('old');
    await wp.post('wp/v2/posts/1', { title: 'new' });
    expect((await wp.get<{ title: string }>('wp/v2/posts/1')).data.title).toBe('new');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not cache a read that was in flight during a write', async () => {
    let title = 'old';
    let releaseRead: () => void = () => undefined;
    mockFetch(async (_url, init) => {
      if (init.method === 'POST') {
        title = 'new';
        return jsonResponse({ title });
      }
      const snapshot = title;
      await new Promise<void>((resolve) => (releaseRead = resolve));
      return jsonResponse({ title: snapshot });
    });
    const wp = new WpClient(testConfig({ WP_USER: 'u', WP_APP_PASSWORD: 'p' }));

    const inFlight = wp.get<{ title: string }>('wp/v2/posts/1');
    await wp.post('wp/v2/posts/1', { title: 'new' });
    releaseRead();
    expect((await inFlight).data.title).toBe('old');

    const fresh = wp.get<{ title: string }>('wp/v2/posts/1');
    releaseRead();
    expect((await fresh).data.title).toBe('new');
  });

  it('uploads raw bytes with a safe Content-Disposition file name', async () => {
    const fetch = mockFetch(() => jsonResponse({ id: 327 }));
    await new WpClient(testConfig({ WP_USER: 'u', WP_APP_PASSWORD: 'p' })).upload(
      new ArrayBuffer(4),
      'a"b\r\n.png',
      'image/png',
    );
    const headers = fetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['Content-Disposition']).toBe('attachment; filename="a_b__.png"');
    expect(headers['Content-Type']).toBe('image/png');
  });
});
