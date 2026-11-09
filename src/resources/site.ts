import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AcfSchema } from '../wp/acf-schema.js';
import type { CompanyInfoService } from '../wp/company.js';
import { detectFeatures } from '../wp/features.js';
import { decodeEntities } from '../wp/format.js';
import type { SiteModel } from '../wp/site-model.js';

export function registerSiteResources(
  server: McpServer,
  site: SiteModel,
  company: CompanyInfoService,
  acfSchema: AcfSchema,
): void {
  server.registerResource(
    'site-info',
    'wp://site/info',
    {
      title: 'Site info',
      description: 'Site name, tagline, URL, organization details, content types, and taxonomies.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const [info, index, types, taxonomies] = await Promise.all([
        company.get(),
        company.index(),
        site.postTypes(),
        site.taxonomies(),
      ]);

      const data = {
        ...info,
        post_types: types.map((type) => ({
          slug: type.slug,
          name: decodeEntities(type.name),
          rest_route: `${type.rest_namespace}/${type.rest_base}`,
          taxonomies: type.taxonomies,
        })),
        taxonomies: taxonomies.map((tax) => ({
          slug: tax.slug,
          name: decodeEntities(tax.name),
          post_types: tax.types,
        })),
        features: { ...detectFeatures(index.namespaces), acfJson: acfSchema.hasAcfJson },
      };

      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
