import { afterEach, describe, expect, it, vi } from 'vitest';
import { can, verifyUser } from '../src/wp/auth.js';
import { WpClient } from '../src/wp/client.js';
import { testConfig } from './helpers.js';

const EDITOR = {
  id: 3,
  name: 'MCP Editor',
  roles: ['editor'],
  capabilities: { edit_posts: true, edit_pages: true, upload_files: true },
};

function stubUsersMe(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
    ),
  );
}

const signedIn = (): WpClient => new WpClient(testConfig({ WP_USER: 'mcp-editor', WP_APP_PASSWORD: 'abcd efgh' }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyUser', () => {
  it('never signs in for the public profile', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await verifyUser(signedIn(), 'public')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires credentials for editor and dev', async () => {
    await expect(verifyUser(new WpClient(testConfig()), 'editor')).rejects.toThrow(/needs WP_USER and WP_APP_PASSWORD/);
  });

  it('returns the user when the capabilities are there', async () => {
    stubUsersMe(200, EDITOR);
    const user = await verifyUser(signedIn(), 'editor');
    expect(user?.name).toBe('MCP Editor');
    expect(can(user, 'edit_theme_options')).toBe(false);
  });

  it('reports missing capabilities', async () => {
    stubUsersMe(200, { ...EDITOR, roles: ['author'], capabilities: { edit_posts: true } });
    await expect(verifyUser(signedIn(), 'editor')).rejects.toThrow(/lacks edit_pages, upload_files/);
  });

  it.each([
    [401, { code: 'rest_not_logged_in', message: 'You are not currently logged in.' }],
    // Wordfence hides the users endpoint from anonymous requests, so a failed login looks like a 404.
    [404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' }],
  ])('treats HTTP %i as a failed login and points to Wordfence', async (status, body) => {
    stubUsersMe(status, body);
    await expect(verifyUser(signedIn(), 'editor')).rejects.toThrow(/did not accept the login.*Wordfence/s);
  });
});
