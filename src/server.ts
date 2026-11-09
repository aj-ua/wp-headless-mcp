import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { registerContentResources } from './resources/content.js';
import { registerSiteResources } from './resources/site.js';
import { registerAcfTools } from './tools/acf.js';
import { registerPrompts } from './prompts/index.js';
import { registerAuditTools, registerMenuTools } from './tools/audit.js';
import { registerContentTools } from './tools/content.js';
import { registerCptTools, resolveCpts, type ResolvedCpt } from './tools/cpt.js';
import { registerDevTools } from './tools/dev.js';
import { registerEditorTools } from './tools/editor.js';
import { registerSeoTools } from './tools/seo.js';
import { registerSiteTools } from './tools/site.js';
import { AcfSchema } from './wp/acf-schema.js';
import { AcfSearch } from './wp/acf-search.js';
import { can, verifyUser, type CurrentUser } from './wp/auth.js';
import { WpClient } from './wp/client.js';
import { CompanyInfoService } from './wp/company.js';
import { detectFeatures, loadFeatures, type SiteFeatures } from './wp/features.js';
import { PostService } from './wp/posts.js';
import { SiteModel } from './wp/site-model.js';

const NO_FEATURES: SiteFeatures = detectFeatures([]);

function buildInstructions(
  config: Config,
  cpts: ResolvedCpt[],
  features: SiteFeatures,
  user: CurrentUser | undefined,
): string {
  const cptHint =
    cpts.length > 0
      ? `Custom post types have their own tools: ${cpts
          .map((cpt) => `list_${cpt.plural} / get_${cpt.singular} (${cpt.label})`)
          .join(', ')}. `
      : '';
  const seoHint = features.yoast
    ? 'For SEO questions, use get_seo_meta for one page and find_seo_issues for a site-wide check. '
    : '';
  const editorHint =
    config.profile === 'editor'
      ? `You are signed in as "${user?.name ?? 'unknown'}". Editing tools only create or change drafts and pending items; ` +
        'they never publish or delete. To change a published item, create_draft with copy_from, then share the ' +
        'preview and edit links so a person can review and publish it. Use content_audit to find content to improve. '
      : '';
  const devHint =
    config.profile === 'dev'
      ? 'For PWA development: describe_content_model for the overview, get_acf_schema for field details, ' +
        'generate_ts_types for TypeScript interfaces, sample_payload for raw REST JSON, and ' +
        'check_site_requirements and site_health to find setup problems. '
      : '';

  const intro =
    config.profile === 'public'
      ? `Tools for reading published content from the WordPress site at ${config.wpUrl}. `
      : `Tools for the WordPress site at ${config.wpUrl} (profile: ${config.profile}). `;

  return (
    intro +
    'Start with list_post_types to see what the site contains, and get_company_info for who runs it. ' +
    cptHint +
    'Use search_content to find items by keyword, list_posts to browse any post type, ' +
    'list_terms for categories and tags, get_post to read one item in full, ' +
    'and get_acf_fields to see what each custom field means. ' +
    seoHint +
    editorHint +
    devHint +
    'Cite the item URL when answering questions about site content.'
  );
}

/** Builds a fresh MCP server instance. Cheap: all site data was read once at startup. */
export type ServerFactory = () => McpServer;

/**
 * Reads the site once (signed-in user, custom post types, plugins) and returns a factory
 * for server instances. stdio uses one instance; HTTP builds one per request or session,
 * and all of them share the same WordPress client and cache.
 */
export async function createServerFactory(config: Config): Promise<ServerFactory> {
  // The public profile never signs in, even if credentials are set,
  // so it can only ever see published content.
  const clientConfig: Config =
    config.profile === 'public' ? { ...config, wpUser: undefined, wpAppPassword: undefined } : config;

  const wp = new WpClient(clientConfig);
  const site = new SiteModel(wp);
  const posts = new PostService(wp, site);
  const acfSchema = new AcfSchema(wp, site, config.acfJsonPath);
  const company = new CompanyInfoService(wp);
  const acfSearch = new AcfSearch(wp, site);

  // Fails fast on a wrong password or missing capabilities for editor and dev.
  const user = await verifyUser(wp, config.profile);

  let cpts: ResolvedCpt[] = [];
  try {
    cpts = await resolveCpts(config, site);
  } catch (error) {
    // A wrong MCP_CPTS entry is a config mistake and should stop startup.
    if (config.cpts !== 'auto') {
      throw error;
    }
    // In auto mode, an unreachable site shouldn't stop the server; the generic tools still work later.
    console.error(`Could not load post types for custom post type tools: ${(error as Error).message}`);
  }

  let features = NO_FEATURES;
  try {
    features = await loadFeatures(wp);
  } catch (error) {
    console.error(`Could not detect site features; optional tools are off: ${(error as Error).message}`);
  }

  const instructions = buildInstructions(config, cpts, features, user);
  const canManageMenus = can(user, 'edit_theme_options');

  return () => {
    const server = new McpServer({ name: 'wp-headless-mcp', version: '1.0.0' }, { instructions });

    // Read tools: every profile.
    registerContentTools(server, wp, site, posts, acfSearch);
    registerCptTools(server, posts, cpts);
    registerAcfTools(server, posts, acfSchema);
    registerSiteTools(server, company);
    if (features.yoast) {
      registerSeoTools(server, wp, site);
    }

    // Editing tools: editor profile only. They write drafts and never publish or delete.
    if (config.profile === 'editor') {
      registerEditorTools(server, wp, site, posts, acfSchema);
      registerAuditTools(server, wp, site, features);
      if (canManageMenus) {
        registerMenuTools(server, wp);
      }
    }

    // Developer tools: dev profile only. Read-only.
    if (config.profile === 'dev') {
      registerDevTools(server, wp, site, acfSchema, features);
    }

    registerPrompts(server, {
      profile: config.profile,
      features,
      cptGetTools: cpts.map((cpt) => `get_${cpt.singular}`),
    });

    registerSiteResources(server, site, company, acfSchema);
    registerContentResources(server, site, posts);

    return server;
  };
}
