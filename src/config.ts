export type Profile = 'public' | 'editor' | 'dev';

/** Tool naming for one custom post type, e.g. project → list_projects / get_project. */
export interface CptToolConfig {
  readonly postType: string;
  readonly singular: string;
  readonly plural: string;
}

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  /** Shared secret clients send as "Authorization: Bearer <token>". */
  readonly token: string;
  /** Browser origins allowed to call the server (CORS). Empty means none: server-to-server only. */
  readonly allowedOrigins: readonly string[];
  /** Keep a session per client (Mcp-Session-Id). Off by default: each request is independent. */
  readonly sessions: boolean;
  readonly sessionIdleMinutes: number;
}

export interface Config {
  readonly wpUrl: string;
  readonly wpUser: string | undefined;
  readonly wpAppPassword: string | undefined;
  readonly profile: Profile;
  readonly cacheTtlSeconds: number;
  /** Absolute path to the theme's acf-json folder, used for ACF field labels and schemas. */
  readonly acfJsonPath: string | undefined;
  /** 'auto' generates tools for every custom post type; 'none' disables them. */
  readonly cpts: 'auto' | 'none' | readonly CptToolConfig[];
  readonly transport: 'stdio' | 'http';
  /** Set when transport is "http". */
  readonly http: HttpConfig | undefined;
}

const PROFILES: readonly Profile[] = ['public', 'editor', 'dev'];
const TOOL_NAME_PART = /^[a-z0-9_]+$/;
const MIN_TOKEN_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const wpUrl = env.WP_URL?.trim().replace(/\/+$/, '');
  if (!wpUrl) {
    throw new Error('WP_URL is required (for example http://aj-ua.local).');
  }

  const profile = (env.MCP_PROFILE ?? 'public') as Profile;
  if (!PROFILES.includes(profile)) {
    throw new Error(`MCP_PROFILE must be one of: ${PROFILES.join(', ')}.`);
  }

  const ttl = Number(env.WP_CACHE_TTL ?? 60);

  const transport = (env.MCP_TRANSPORT ?? 'stdio') as Config['transport'];
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error('MCP_TRANSPORT must be "stdio" or "http".');
  }

  return {
    wpUrl,
    wpUser: env.WP_USER || undefined,
    wpAppPassword: env.WP_APP_PASSWORD || undefined,
    profile,
    cacheTtlSeconds: Number.isFinite(ttl) && ttl >= 0 ? ttl : 60,
    acfJsonPath: env.ACF_JSON_PATH?.trim() || undefined,
    cpts: parseCpts(env.MCP_CPTS),
    transport,
    http: transport === 'http' ? parseHttp(env) : undefined,
  };
}

function parseHttp(env: NodeJS.ProcessEnv): HttpConfig {
  const token = env.MCP_HTTP_TOKEN?.trim() ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `MCP_TRANSPORT=http needs MCP_HTTP_TOKEN of at least ${MIN_TOKEN_LENGTH} characters. ` +
        'Generate one with: openssl rand -hex 32',
    );
  }

  const port = Number(env.MCP_HTTP_PORT ?? 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MCP_HTTP_PORT must be a port number between 1 and 65535.');
  }

  const allowedOrigins = (env.MCP_HTTP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    if (!/^https?:\/\/[^/]+$/.test(origin)) {
      throw new Error(
        `MCP_HTTP_ALLOWED_ORIGINS entry "${origin}" must be an origin: scheme and host, optional port, no path.`,
      );
    }
  }

  const idle = Number(env.MCP_HTTP_SESSION_IDLE_MINUTES ?? 30);

  return {
    host: env.MCP_HTTP_HOST?.trim() || '127.0.0.1',
    port,
    token,
    allowedOrigins,
    sessions: env.MCP_HTTP_SESSIONS === 'true',
    sessionIdleMinutes: Number.isFinite(idle) && idle > 0 ? idle : 30,
  };
}

/**
 * MCP_CPTS is "auto" (default), "none", or a JSON array like
 * [{"postType":"case-study","singular":"case_study","plural":"case_studies"}].
 */
function parseCpts(raw: string | undefined): Config['cpts'] {
  const value = raw?.trim();
  if (!value || value === 'auto') {
    return 'auto';
  }
  if (value === 'none') {
    return 'none';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('MCP_CPTS must be "auto", "none", or a JSON array.');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('MCP_CPTS JSON must be an array.');
  }

  return parsed.map((item: unknown, i): CptToolConfig => {
    const entry = item as Partial<CptToolConfig>;
    if (!entry.postType || !entry.singular || !entry.plural) {
      throw new Error(`MCP_CPTS[${i}] needs postType, singular, and plural.`);
    }
    if (!TOOL_NAME_PART.test(entry.singular) || !TOOL_NAME_PART.test(entry.plural)) {
      throw new Error(`MCP_CPTS[${i}]: singular and plural may only contain a-z, 0-9, and underscores.`);
    }
    return { postType: entry.postType, singular: entry.singular, plural: entry.plural };
  });
}
