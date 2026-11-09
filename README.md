# wp-headless-mcp

An MCP server that lets AI assistants read, and safely help edit, the content of a WordPress website.

It connects a company's WordPress site (pages, posts, custom post types like projects or services, ACF fields, and Yoast SEO data) to AI clients such as Claude. Then people can ask questions about the site, or get help with its content, in plain language.

> **Status:** feature-complete for its first version and tested against a real WordPress site, with 120 unit tests.

---

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io) is an open standard for connecting AI assistants to data and tools. An MCP server describes what it can do as:

- **Tools:** actions the AI can call, like "search the site" or "list recent projects".
- **Resources:** content the AI can read, like a specific page or the site's content model.
- **Prompts:** reusable task templates, like "review this page's SEO".

Any MCP-compatible client (Claude Desktop, Claude Code, the Claude API, and others) can use the same server without custom integration work.

## The problem it solves

Many companies already keep their website content in WordPress: services, case studies, team members, FAQs, products. When they build something new on top of it, like a **Progressive Web App (PWA)**, that content is often:

- **Hard for AI to use.** A chatbot or assistant needs grounded, current answers, not guesses. Wiring an LLM to the WordPress REST API by hand is repetitive and easy to get wrong.
- **Locked behind admin screens.** Content and marketing staff can't quickly ask "which pages have no meta description?" or "draft a post about our new service".
- **Undocumented for developers.** PWA developers have to discover post types, ACF field structures, and REST payloads by trial and error.

`wp-headless-mcp` gives all of these people one well-defined, safe AI gateway to the site.

## How it fits with a PWA

```
                    ┌────────────────────────────┐
                    │     WordPress website      │
                    │  pages · projects · ACF ·  │
                    │  · Yoast SEO               │
                    └─────────────┬──────────────┘
                                  │ REST API
              ┌───────────────────┴───────────────────┐
              │                                       │
     PWA user interface                        wp-headless-mcp
  (reads REST API directly:                  (AI layer: tools,
   pages, lists, images)                     resources, prompts)
                                                      │
                               ┌──────────────────────┼──────────────────────┐
                               │                      │                      │
                      AI assistant in the PWA   Content team in      Developers in
                      (via the PWA backend      Claude Desktop       Claude Code
                       and the Claude API)
```

The PWA keeps reading content from WordPress directly for its normal screens. The MCP server sits next to it and powers the **AI features**, plus the tools around the site.

## Who it's for

### Website visitors (through the PWA)

An AI assistant inside the PWA that answers questions using the company's own content and links to the source page.

- "What services do you offer for product design?"
- "Show me projects you've done for retail companies."
- "How can I get in touch?"

It only sees published, public content and can't change anything.

### Content and marketing team

Staff connect Claude Desktop to the site and work with content conversationally.

- "Which projects are missing a featured image or SEO description?"
- "Draft a case study for our latest project in the same style as the others."
- "Update the subtitle on the Acme project." (saved as a draft for review)

Changes are always saved as **drafts or pending review**. The AI never publishes or deletes content.

### PWA developers

Developers connect Claude Code while building the PWA.

- "What post types and ACF fields does this site have?"
- "Generate TypeScript types for the project post type, including its ACF fields."
- "Show me a sample REST payload for a project."
- "Does this site meet the requirements for headless use?"

### Agencies and freelancers

The server isn't tied to one website. Point it at any WordPress site that meets the [site requirements](#site-requirements) to add AI features for a client, audit content, or speed up headless builds. Need help with a client project? See [setup and custom work](#setup-and-custom-work).

## What it offers

| Area            | Capabilities                                                                                                                        | Profile                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Content         | Search across the site, including ACF fields; get or list posts, pages, and custom post types; categories and tags; Markdown output | All                        |
| ACF             | Custom field values on any item, with labels and types from `acf-json`                                                              | All                        |
| Company info    | Site name, tagline, organization details and social profiles (from Yoast), and the home page text                                   | All                        |
| SEO             | Yoast titles, descriptions, canonical URLs, social images; per-page review and a site-wide issue scan                               | All (when Yoast is active) |
| Editing         | Create and update drafts, copy published items into drafts, update ACF fields, upload media, list drafts                            | `editor`                   |
| Audit           | Missing featured images, alt text, meta descriptions, excerpts, and stale content                                                   | `editor`                   |
| Developer tools | Content model, ACF schema, sample payloads, TypeScript type generation, site requirement and health checks                          | `dev`                      |
| Prompts         | Answer a visitor, SEO review, write a blog draft, weekly content report                                                             | All / `editor`             |

## Access profiles

One server, three profiles. The profile decides which tools exist at all, so a public deployment can't expose editing tools even by mistake.

| Profile  | For                        | Can do                                                                               |
| -------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `public` | AI assistant in the PWA    | Read published content. Never signs in, even if credentials are set                  |
| `editor` | Content and marketing team | Read, plus create and update drafts, audits, and menus (menus need an Administrator) |
| `dev`    | Developers                 | Read, plus schemas, type generation, payload samples, and site checks                |

The `editor` and `dev` profiles sign in with a WordPress **Application Password**, so WordPress's own user roles and permissions still apply. The server checks the login and the user's capabilities at startup.

## Design principles

- **No plugin required.** The server reads only the standard WordPress REST API, so nothing extra needs installing on the client's site.
- **Safe by default.** Read-only for the public. Drafts only for editors: published items can't be changed, only copied into a draft for review. No delete actions anywhere.
- **Grounded answers.** Tools return source URLs so the AI can cite where information came from.
- **Small, clean responses.** HTML is converted to Markdown and unused metadata is removed, which keeps AI responses fast and inexpensive.
- **Works across sites.** Post types and REST routes are discovered automatically, not hardcoded. Optional integrations such as Yoast SEO only appear when the site has them.

## Site requirements

To work fully, a WordPress site should:

1. Register custom post types that AI clients should see with `show_in_rest => true`.
2. Save ACF field groups to the theme's `acf-json` folder.
3. Turn on **"Show in REST API"** for ACF field groups that hold public content.
4. Keep Application Passwords enabled (the WordPress default) for the editor and dev profiles. Security plugins such as Wordfence can turn them off.

The `dev` profile's `check_site_requirements` tool checks these for you.

**Known limits:** ACF options pages (site-wide settings like phone and email) aren't reachable through the REST API, and menus need a signed-in Administrator.

## Getting started

Requirements: Node.js 22 or newer, and a WordPress site whose REST API is reachable.

```
npm install
cp .env.example .env
npm run build
```

Edit `.env` and set at least `WP_URL`. For the editor or dev profile, also create an Application Password (wp-admin → Users → Profile → Application Passwords, ideally for a dedicated user with the Editor role) and set `WP_USER` and `WP_APP_PASSWORD`.

### Try it in the MCP Inspector

```
npm run inspect
```

The Inspector opens in the browser. Click Connect, then try the tools, resources, and prompts.

### Connect Claude Code

```
claude mcp add wp-headless-mcp -e WP_URL=http://aj-ua.local -- node /absolute/path/to/wp-headless-mcp/dist/index.js
```

Add `-e MCP_PROFILE=editor -e WP_USER=... -e WP_APP_PASSWORD=...` for the editing tools.

### Connect Claude Desktop

Add the server to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "node",
      "args": ["/absolute/path/to/wp-headless-mcp/dist/index.js"],
      "env": {
        "WP_URL": "http://aj-ua.local",
        "MCP_PROFILE": "editor",
        "WP_USER": "mcp-editor",
        "WP_APP_PASSWORD": "<application password>",
        "ACF_JSON_PATH": "/absolute/path/to/wp-content/themes/your-theme/acf-json"
      }
    }
  }
}
```

### Connect a PWA backend

Run the server in HTTP mode and call it from the backend. Setup, security, and runnable Claude API examples: [docs/PWA_BACKEND.md](docs/PWA_BACKEND.md).

## Configuration

All settings are environment variables, read from the environment or `.env`.

| Variable                        | Default     | Purpose                                                                                                                     |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `WP_URL`                        | required    | Site base URL, for example `http://aj-ua.local`                                                                             |
| `WP_USER`                       | —           | Application Password user (editor and dev profiles)                                                                         |
| `WP_APP_PASSWORD`               | —           | Application Password                                                                                                        |
| `MCP_PROFILE`                   | `public`    | `public`, `editor`, or `dev`                                                                                                |
| `WP_CACHE_TTL`                  | `60`        | Seconds to cache GET requests; `0` turns caching off                                                                        |
| `ACF_JSON_PATH`                 | —           | Path to the theme's `acf-json` folder, for ACF labels, schemas, and TypeScript types                                        |
| `MCP_CPTS`                      | `auto`      | Custom post type tools: `auto`, `none`, or JSON such as `[{"postType":"project","singular":"project","plural":"projects"}]` |
| `MCP_TRANSPORT`                 | `stdio`     | `stdio` for local clients, `http` for remote clients                                                                        |
| `MCP_HTTP_TOKEN`                | —           | Bearer token for HTTP mode, at least 32 characters (`openssl rand -hex 32`)                                                 |
| `MCP_HTTP_HOST`                 | `127.0.0.1` | HTTP bind address; use `0.0.0.0` only behind an HTTPS reverse proxy                                                         |
| `MCP_HTTP_PORT`                 | `3333`      | HTTP port                                                                                                                   |
| `MCP_HTTP_SESSIONS`             | `false`     | `true` keeps one session per client; default is stateless                                                                   |
| `MCP_HTTP_SESSION_IDLE_MINUTES` | `30`        | Idle session timeout                                                                                                        |
| `MCP_HTTP_ALLOWED_ORIGINS`      | —           | Comma-separated browser origins allowed by CORS; empty means server-to-server only                                          |

## Reference

### Tools

All profiles:

| Tool                         | What it does                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `list_post_types`            | Content types with published counts and taxonomies                                 |
| `search_content`             | Keyword search; `results` from WordPress search plus `acf_matches` from ACF fields |
| `list_posts` / `get_post`    | List or read any post type; body as Markdown, ACF fields, featured image, terms    |
| `list_<type>` / `get_<type>` | Generated per custom post type, for example `list_projects` and `get_project`      |
| `list_terms`                 | Categories, tags, and custom taxonomy terms                                        |
| `get_acf_fields`             | One item's ACF values with labels, types, and field groups                         |
| `get_company_info`           | Site, organization, social profiles, and home page text                            |
| `get_seo_meta`               | Yoast SEO data and issues for one item or URL (Yoast only)                         |
| `find_seo_issues`            | Site-wide SEO scan with counts per issue (Yoast only)                              |

`editor` profile:

| Tool                | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `create_draft`      | New draft, optionally copied from an existing item (`copy_from`)            |
| `update_post`       | Change a draft or pending item; can submit it for review                    |
| `update_acf_fields` | Set ACF values on a draft or pending item, checked against its field groups |
| `list_drafts`       | Drafts and pending items with edit links                                    |
| `upload_media`      | Add an image or PDF from a public URL, with alt text                        |
| `content_audit`     | Missing images, alt text, descriptions, excerpts, and stale content         |
| `get_menu`          | Navigation menus as a tree (Administrators only)                            |

`dev` profile:

| Tool                      | What it does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `describe_content_model`  | Post types, REST routes, taxonomy fields, and ACF groups per type                  |
| `get_acf_schema`          | Full ACF field definitions                                                         |
| `sample_payload`          | Raw REST JSON for a content route                                                  |
| `generate_ts_types`       | TypeScript interfaces for a post type, in `standard` or `light` ACF format         |
| `check_site_requirements` | Checks the site requirements above                                                 |
| `site_health`             | WordPress version, namespaces, plugins, HTTPS, timezone, and CORS for a PWA origin |

### Resources

| URI                     | Content                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `wp://site/info`        | Site, organization, post types, taxonomies, and detected features (JSON) |
| `wp://post/{type}/{id}` | One item as Markdown, including ACF fields                               |
| `wp://page/{slug}`      | One page as Markdown, including ACF fields                               |

### Prompts

| Prompt                    | Profile          | What it does                                              |
| ------------------------- | ---------------- | --------------------------------------------------------- |
| `answer_visitor_question` | All              | Answers from site content only, with links                |
| `seo_review`              | All (Yoast only) | Reviews one item and proposes fixes                       |
| `write_blog_draft`        | `editor`         | Writes a post in the site's style and saves it as a draft |
| `weekly_content_report`   | `editor`         | Recent changes, drafts waiting for review, and top issues |

## Development

| Command                                  | What it does                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev`                            | Run from source with `tsx` (stdio)                                                    |
| `npm run build` / `npm start`            | Compile to `dist/` and run it                                                         |
| `npm run inspect`                        | Open the MCP Inspector against the source                                             |
| `npm test`                               | Unit tests (vitest), no network needed                                                |
| `npm run lint` / `npm run format`        | ESLint and Prettier                                                                   |
| `npm run check`                          | Everything CI should run: type checks, lint, formatting, and tests                    |
| `npm run example:client -- "<question>"` | Ask Claude a question through the server ([docs/PWA_BACKEND.md](docs/PWA_BACKEND.md)) |

The tests use recorded aj-ua responses in `tests/fixtures/`. Build and type checks use TypeScript 7 (installed as `typescript7`). TypeScript 6.0 is also installed, only for ESLint and the type-generator test, because `typescript-eslint` and TypeScript's JavaScript API don't support TypeScript 7 yet.

## Roadmap

- Remove the TypeScript 6.0.3 copy once `typescript-eslint` supports TypeScript 7.
- Test Claude's MCP connector ([option A](docs/PWA_BACKEND.md)) once the server runs at a public HTTPS address.

## Tech stack

- TypeScript on Node.js 22
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) and `zod`
- `turndown` for HTML to Markdown
- WordPress REST API (core, ACF, Yoast)
- vitest, ESLint (`typescript-eslint`), and Prettier

## Setup and custom work

I build and maintain `wp-headless-mcp`, and I'm available for paid work around it:

- **Setup:** connect the server to your WordPress site, map your post types and ACF fields, and configure access profiles.
- **Custom tools:** add tools, resources, or prompts for your site's content model and workflows.
- **AI features for your PWA:** build an assistant that answers visitors' questions from your own content.
- **Team onboarding:** help your content team use it day to day in Claude Desktop.

Get in touch through [aj-ua.com](https://aj-ua.com/) or [LinkedIn](https://www.linkedin.com/in/andrii-shamardak-65153b106/).

## License

[MIT](LICENSE)
