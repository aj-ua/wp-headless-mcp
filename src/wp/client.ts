import type { Config } from '../config.js';

export type QueryValue = string | number | boolean | undefined;

export interface WpResponse<T> {
  readonly data: T;
  readonly total: number | undefined;
  readonly totalPages: number | undefined;
}

export class WpApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'WpApiError';
  }
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly value: WpResponse<unknown>;
}

/**
 * Thin client for the WordPress REST API with optional
 * Application Password auth, an in-memory GET cache, and write helpers.
 */
export class WpClient {
  private readonly cache = new Map<string, CacheEntry>();
  /** Bumped on every write, so reads that started before a write are not cached. */
  private generation = 0;
  private readonly authHeader: string | undefined;

  public constructor(private readonly config: Config) {
    if (config.wpUser && config.wpAppPassword) {
      const token = Buffer.from(`${config.wpUser}:${config.wpAppPassword}`).toString('base64');
      this.authHeader = `Basic ${token}`;
    }
  }

  public get siteUrl(): string {
    return this.config.wpUrl;
  }

  public async get<T>(route: string, query: Record<string, QueryValue> = {}): Promise<WpResponse<T>> {
    return this.cachedRequest<T>('GET', route, query);
  }

  /** OPTIONS request, which returns a route's JSON schema (including ACF field types). */
  public async options<T>(route: string): Promise<WpResponse<T>> {
    return this.cachedRequest<T>('OPTIONS', route, {});
  }

  public get isAuthenticated(): boolean {
    return this.authHeader !== undefined;
  }

  public get username(): string | undefined {
    return this.authHeader ? this.config.wpUser : undefined;
  }

  /** JSON POST, used by WordPress for both creating and updating items. Never cached. */
  public async post<T>(route: string, body: Record<string, unknown>): Promise<WpResponse<T>> {
    this.requireAuth();
    const response = await fetch(this.buildUrl(route, {}), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await this.parse<T>(response);
    this.invalidate();
    return result;
  }

  /** Uploads a file to the media library (POST /wp/v2/media with the raw file body). */
  public async upload<T>(bytes: ArrayBuffer, filename: string, contentType: string): Promise<WpResponse<T>> {
    this.requireAuth();
    const safeName = filename.replace(/["\\\r\n]/g, '_');
    const response = await fetch(this.buildUrl('wp/v2/media', {}), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${safeName}"`,
      },
      body: bytes,
    });
    const result = await this.parse<T>(response);
    this.invalidate();
    return result;
  }

  /**
   * Raw GET of any path on the site (not only /wp-json), returning status, headers, and text.
   * Never cached. Used by diagnostics such as sitemap and CORS checks.
   */
  public async probe(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const url = new URL(path.replace(/^\/*/, '/'), `${this.config.wpUrl}/`);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  /** Writes can change any list or item, so cached reads are dropped. */
  private invalidate(): void {
    this.generation += 1;
    this.cache.clear();
  }

  private requireAuth(): void {
    if (!this.authHeader) {
      throw new Error('Writing to WordPress needs WP_USER and WP_APP_PASSWORD.');
    }
  }

  private async cachedRequest<T>(
    method: 'GET' | 'OPTIONS',
    route: string,
    query: Record<string, QueryValue>,
  ): Promise<WpResponse<T>> {
    const url = this.buildUrl(route, query);
    const cacheKey = `${method} ${url}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as WpResponse<T>;
    }

    const startedAt = this.generation;
    const response = await fetch(url, { method, headers: this.headers() });
    const result = await this.parse<T>(response);

    // Skip caching if a write happened while this read was in flight; the result may be stale.
    if (this.config.cacheTtlSeconds > 0 && startedAt === this.generation) {
      this.cache.set(cacheKey, { expiresAt: Date.now() + this.config.cacheTtlSeconds * 1000, value: result });
    }

    return result;
  }

  private buildUrl(route: string, query: Record<string, QueryValue>): string {
    const url = new URL(`${this.config.wpUrl}/wp-json/${route.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    return headers;
  }

  private async parse<T>(response: Response): Promise<WpResponse<T>> {
    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const error = (body ?? {}) as { message?: string; code?: string };
      throw new WpApiError(error.message ?? `WordPress returned HTTP ${response.status}.`, response.status, error.code);
    }

    const total = response.headers.get('X-WP-Total');
    const totalPages = response.headers.get('X-WP-TotalPages');

    return {
      data: body as T,
      total: total === null ? undefined : Number(total),
      totalPages: totalPages === null ? undefined : Number(totalPages),
    };
  }
}
