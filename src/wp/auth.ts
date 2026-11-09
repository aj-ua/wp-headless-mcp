import type { Profile } from '../config.js';
import { WpApiError, type WpClient } from './client.js';

export interface CurrentUser {
  readonly id: number;
  readonly name: string;
  readonly roles: string[];
  readonly capabilities: Record<string, boolean>;
}

/** Capabilities each signed-in profile needs. */
const REQUIRED_CAPABILITIES: Record<Exclude<Profile, 'public'>, string[]> = {
  editor: ['edit_posts', 'edit_pages', 'upload_files'],
  dev: ['edit_posts'],
};

export function can(user: CurrentUser | undefined, capability: string): boolean {
  return user?.capabilities[capability] === true;
}

/**
 * Signs in with the Application Password and checks the user's capabilities.
 * Throws a readable error so a misconfigured server fails at startup, not mid-task.
 */
export async function verifyUser(wp: WpClient, profile: Profile): Promise<CurrentUser | undefined> {
  if (profile === 'public') {
    return undefined;
  }
  if (!wp.isAuthenticated) {
    throw new Error(
      `MCP_PROFILE=${profile} needs WP_USER and WP_APP_PASSWORD (Users > Profile > Application Passwords in wp-admin).`,
    );
  }

  let user: CurrentUser;
  try {
    user = (await wp.get<CurrentUser>('wp/v2/users/me', { context: 'edit', _fields: 'id,name,roles,capabilities' }))
      .data;
  } catch (error) {
    // A failed login is a 401, or a 404 when a security plugin hides the users
    // endpoint from anonymous requests (Wordfence's "prevent username discovery").
    const loginFailed =
      error instanceof WpApiError && (error.status === 401 || (error.status === 404 && error.code === 'rest_no_route'));
    if (loginFailed) {
      throw new Error(
        `WordPress did not accept the login for WP_USER "${wp.username ?? ''}". Check the Application Password. ` +
          'If Wordfence is active, turn off "Disable WordPress application passwords" ' +
          '(Wordfence > All Options > Brute Force Protection).',
        { cause: error },
      );
    }
    throw error;
  }

  const missing = REQUIRED_CAPABILITIES[profile].filter((capability) => !can(user, capability));
  if (missing.length > 0) {
    throw new Error(
      `WP user "${user.name}" (roles: ${user.roles.join(', ')}) lacks ${missing.join(', ')}, ` +
        `which MCP_PROFILE=${profile} needs. Use a user with the Editor or Administrator role.`,
    );
  }

  return user;
}
