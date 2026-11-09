import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompanyInfoService } from '../wp/company.js';
import { READ_ONLY } from './inputs.js';
import { jsonResult, toolError } from './result.js';

export function registerSiteTools(server: McpServer, company: CompanyInfoService): void {
  server.registerTool(
    'get_company_info',
    {
      title: 'Get company and site info',
      description:
        'Returns the site name, tagline, URL, and timezone, plus the organization behind the site ' +
        '(name, logo, social profiles, and contact details when published) from Yoast SEO data, ' +
        'and the text of the home page, where sites usually say who they are and what they do.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return jsonResult(await company.get());
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
