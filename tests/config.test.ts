import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const TOKEN = 'a'.repeat(32);

describe('loadConfig', () => {
  it('applies defaults and trims the trailing slash from WP_URL', () => {
    const config = loadConfig({ WP_URL: 'http://aj-ua.local/' });
    expect(config).toMatchObject({
      wpUrl: 'http://aj-ua.local',
      profile: 'public',
      cacheTtlSeconds: 60,
      cpts: 'auto',
      transport: 'stdio',
      http: undefined,
    });
  });

  it('requires WP_URL and a known profile', () => {
    expect(() => loadConfig({})).toThrow(/WP_URL is required/);
    expect(() => loadConfig({ WP_URL: 'http://aj-ua.local', MCP_PROFILE: 'admin' })).toThrow(/MCP_PROFILE/);
  });

  it('parses MCP_CPTS as auto, none, or a validated JSON list', () => {
    const base = { WP_URL: 'http://aj-ua.local' };
    expect(loadConfig({ ...base, MCP_CPTS: 'none' }).cpts).toBe('none');
    expect(
      loadConfig({ ...base, MCP_CPTS: '[{"postType":"project","singular":"work_item","plural":"portfolio"}]' }).cpts,
    ).toEqual([{ postType: 'project', singular: 'work_item', plural: 'portfolio' }]);
    expect(() => loadConfig({ ...base, MCP_CPTS: '{nope' })).toThrow(/JSON array/);
    expect(() => loadConfig({ ...base, MCP_CPTS: '[{"postType":"project"}]' })).toThrow(
      /needs postType, singular, and plural/,
    );
    expect(() =>
      loadConfig({ ...base, MCP_CPTS: '[{"postType":"project","singular":"Bad-Name","plural":"x"}]' }),
    ).toThrow(/a-z, 0-9/);
  });

  describe('HTTP transport', () => {
    const base = { WP_URL: 'http://aj-ua.local', MCP_TRANSPORT: 'http' };

    it('requires a token of at least 32 characters', () => {
      expect(() => loadConfig(base)).toThrow(/MCP_HTTP_TOKEN/);
      expect(() => loadConfig({ ...base, MCP_HTTP_TOKEN: 'short' })).toThrow(/at least 32/);
    });

    it('applies HTTP defaults', () => {
      expect(loadConfig({ ...base, MCP_HTTP_TOKEN: TOKEN }).http).toEqual({
        host: '127.0.0.1',
        port: 3333,
        token: TOKEN,
        allowedOrigins: [],
        sessions: false,
        sessionIdleMinutes: 30,
      });
    });

    it('validates the port and allowed origins', () => {
      expect(() => loadConfig({ ...base, MCP_HTTP_TOKEN: TOKEN, MCP_HTTP_PORT: '99999' })).toThrow(/MCP_HTTP_PORT/);
      expect(
        loadConfig({
          ...base,
          MCP_HTTP_TOKEN: TOKEN,
          MCP_HTTP_ALLOWED_ORIGINS: 'http://localhost:5173/, https://aj-ua.local',
        }).http?.allowedOrigins,
      ).toEqual(['http://localhost:5173', 'https://aj-ua.local']);
      expect(() =>
        loadConfig({ ...base, MCP_HTTP_TOKEN: TOKEN, MCP_HTTP_ALLOWED_ORIGINS: 'http://localhost:5173/app' }),
      ).toThrow(/must be an origin/);
    });

    it('rejects an unknown transport', () => {
      expect(() => loadConfig({ WP_URL: 'http://aj-ua.local', MCP_TRANSPORT: 'ws' })).toThrow(/MCP_TRANSPORT/);
    });
  });
});
