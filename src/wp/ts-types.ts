import type { AcfFieldDef } from './acf-schema.js';

/** A JSON Schema property as found in a REST route's OPTIONS schema. */
export interface JsonSchemaProperty {
  readonly type?: string | string[];
  readonly format?: string;
  readonly enum?: unknown[];
  readonly items?: JsonSchemaProperty;
  readonly properties?: Record<string, JsonSchemaProperty>;
}

export interface TypeTarget {
  readonly postType: string;
  /** Taxonomy REST fields on the post, e.g. ["categories", "tags"]. */
  readonly taxonomyFields: string[];
  readonly hierarchical: boolean;
}

/** Shapes ACF returns with acf_format=standard. Only the ones a schema uses are emitted. */
const HELPERS: Readonly<Record<string, string>> = {
  AcfImage: `/** Image array as ACF returns it with acf_format=standard. */
export interface AcfImage {
  ID: number;
  id: number;
  title: string;
  filename: string;
  filesize: number;
  url: string;
  link: string;
  alt: string;
  author: string;
  description: string;
  caption: string;
  name: string;
  status: string;
  uploaded_to: number;
  date: string;
  modified: string;
  menu_order: number;
  mime_type: string;
  type: string;
  subtype: string;
  icon: string;
  width: number;
  height: number;
  /** Size URLs plus "<size>-width" and "<size>-height" numbers. */
  sizes: Record<string, string | number>;
}`,
  AcfFile: `export interface AcfFile {
  ID: number;
  id: number;
  title: string;
  filename: string;
  filesize: number;
  url: string;
  link: string;
  alt: string;
  author: string;
  description: string;
  caption: string;
  name: string;
  status: string;
  uploaded_to: number;
  date: string;
  modified: string;
  menu_order: number;
  mime_type: string;
  type: string;
  subtype: string;
  icon: string;
}`,
  AcfPostObject: `/** WP_Post as ACF returns it for relationship and post object fields. */
export interface AcfPostObject {
  ID: number;
  post_author: string;
  post_date: string;
  post_date_gmt: string;
  post_content: string;
  post_title: string;
  post_excerpt: string;
  post_status: string;
  comment_status: string;
  ping_status: string;
  post_password: string;
  post_name: string;
  to_ping: string;
  pinged: string;
  post_modified: string;
  post_modified_gmt: string;
  post_content_filtered: string;
  post_parent: number;
  guid: string;
  menu_order: number;
  post_type: string;
  post_mime_type: string;
  comment_count: string;
  filter: string;
}`,
  AcfLink: `export interface AcfLink {
  title: string;
  url: string;
  target: string;
}`,
  AcfTerm: `export interface AcfTerm {
  term_id: number;
  name: string;
  slug: string;
  taxonomy: string;
  description: string;
  count: number;
}`,
  AcfUser: `export interface AcfUser {
  ID: number;
  user_nicename: string;
  display_name: string;
}`,
  AcfGoogleMap: `export interface AcfGoogleMap {
  address: string;
  lat: number;
  lng: number;
  zoom?: number;
}`,
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function propertyName(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function literalUnion(values: string[]): string {
  return values.length > 0 ? values.map((value) => JSON.stringify(value)).join(' | ') : 'string';
}

function arrayOf(type: string): string {
  return /^[A-Za-z0-9_]+$/.test(type) ? `${type}[]` : `Array<${type}>`;
}

/** Collects named interfaces and helper shapes while types are generated. */
class Collector {
  public readonly interfaces: string[] = [];
  public readonly helpers = new Set<string>();

  public use(helper: string): string {
    this.helpers.add(helper);
    return helper;
  }
}

export type AcfFormat = 'standard' | 'light';

/**
 * Maps one ACF field (from acf-json) to its TypeScript type.
 * "standard" follows each field's return format; "light" (the REST default) returns IDs
 * for images, files, related posts, terms, and users.
 */
function fromAcfField(field: AcfFieldDef, ownerName: string, collector: Collector, format: AcfFormat): string {
  const many = field.multiple === true;
  if (format === 'light') {
    switch (field.type) {
      case 'image':
      case 'file':
      case 'user':
        return many ? 'number[]' : 'number';
      case 'post_object':
        return many ? 'number[]' : 'number';
      case 'gallery':
      case 'relationship':
      case 'taxonomy':
        return 'number[]';
      default:
        break;
    }
  }
  const choices = field.choices ? Object.keys(field.choices) : [];
  const labels = field.choices ? Object.values(field.choices) : [];

  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'wysiwyg':
    case 'email':
    case 'url':
    case 'password':
    case 'oembed':
    case 'color_picker':
    case 'date_picker':
    case 'date_time_picker':
    case 'time_picker':
    case 'page_link':
      return field.type === 'page_link' && many ? 'string[]' : 'string';
    case 'number':
    case 'range':
      return 'number';
    case 'true_false':
      return 'boolean';
    case 'select':
    case 'radio':
    case 'button_group':
    case 'checkbox': {
      let single: string;
      if (field.returnFormat === 'label') {
        single = literalUnion(labels);
      } else if (field.returnFormat === 'array') {
        single = `{ value: ${literalUnion(choices)}; label: string }`;
      } else {
        single = literalUnion(choices);
      }
      return field.type === 'checkbox' || many ? arrayOf(single) : single;
    }
    case 'image':
      return field.returnFormat === 'url'
        ? 'string'
        : field.returnFormat === 'id'
          ? 'number'
          : collector.use('AcfImage');
    case 'file':
      return field.returnFormat === 'url'
        ? 'string'
        : field.returnFormat === 'id'
          ? 'number'
          : collector.use('AcfFile');
    case 'gallery':
      return arrayOf(
        field.returnFormat === 'url' ? 'string' : field.returnFormat === 'id' ? 'number' : collector.use('AcfImage'),
      );
    case 'link':
      return field.returnFormat === 'url' ? 'string' : collector.use('AcfLink');
    case 'relationship':
      return arrayOf(field.returnFormat === 'id' ? 'number' : collector.use('AcfPostObject'));
    case 'post_object': {
      const single = field.returnFormat === 'id' ? 'number' : collector.use('AcfPostObject');
      return many ? arrayOf(single) : single;
    }
    case 'taxonomy': {
      const single = field.returnFormat === 'object' ? collector.use('AcfTerm') : 'number';
      return arrayOf(single);
    }
    case 'user': {
      const single = field.returnFormat === 'id' ? 'number' : collector.use('AcfUser');
      return many ? arrayOf(single) : single;
    }
    case 'google_map':
      return collector.use('AcfGoogleMap');
    case 'group':
      return objectInterface(`${ownerName}${pascalCase(field.name)}`, field.subFields ?? [], collector, format);
    case 'repeater':
      return arrayOf(
        objectInterface(`${ownerName}${pascalCase(field.name)}Row`, field.subFields ?? [], collector, format),
      );
    case 'flexible_content': {
      const layouts = (field.subFields ?? []).map((layout) => {
        const name = `${ownerName}${pascalCase(field.name)}${pascalCase(layout.name)}`;
        return objectInterface(name, layout.subFields ?? [], collector, format, layout.name);
      });
      return arrayOf(layouts.length > 0 ? layouts.join(' | ') : 'Record<string, unknown>');
    }
    default:
      return 'unknown';
  }
}

/** True for types whose empty value is an empty string, 0, or false rather than a missing object. */
function isScalar(type: string): boolean {
  return ['string', 'number', 'boolean'].includes(type) || /^"[^"]*"( \| "[^"]*")*$/.test(type);
}

/**
 * Emits an interface for a set of ACF fields and returns its name.
 * Empty values: text is "", while empty arrays and objects (repeaters, images, relationships)
 * come back as false with acf_format=standard and as null in the light format.
 */
function objectInterface(
  name: string,
  fields: AcfFieldDef[],
  collector: Collector,
  format: AcfFormat,
  layout?: string,
): string {
  const lines = fields.map((field) => {
    const comment = field.label ? `  /** ${field.label} (${field.type}) */\n` : '';
    const type = fromAcfField(field, name, collector, format);
    const empty = !isScalar(type) && format === 'standard' ? ' | false | null' : ' | null';
    return `${comment}  ${propertyName(field.name)}: ${type}${empty};`;
  });
  if (layout) {
    lines.unshift(`  acf_fc_layout: ${JSON.stringify(layout)};`);
  }
  collector.interfaces.push(`export interface ${name} {\n${lines.join('\n')}\n}`);
  return name;
}

/** Maps a REST schema property (the default "light" ACF format) to a TypeScript type. */
function fromJsonSchema(prop: JsonSchemaProperty, name: string, collector: Collector): string {
  const types = (Array.isArray(prop.type) ? prop.type : [prop.type ?? 'unknown']).filter((t) => t !== 'null');
  const nullable = Array.isArray(prop.type) && prop.type.includes('null');

  const mapped = types.map((type) => {
    switch (type) {
      case 'string':
        return prop.enum ? literalUnion(prop.enum.map(String)) : 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        return arrayOf(prop.items ? fromJsonSchema(prop.items, `${name}Item`, collector) : 'unknown');
      case 'object': {
        if (!prop.properties) {
          return 'Record<string, unknown>';
        }
        const lines = Object.entries(prop.properties).map(
          ([key, inner]) => `  ${propertyName(key)}: ${fromJsonSchema(inner, `${name}${pascalCase(key)}`, collector)};`,
        );
        collector.interfaces.push(`export interface ${name} {\n${lines.join('\n')}\n}`);
        return name;
      }
      default:
        return 'unknown';
    }
  });

  const union = mapped.length > 0 ? mapped.join(' | ') : 'unknown';
  return nullable ? `${union} | null` : union;
}

function postInterface(target: TypeTarget, typeName: string, acfType: string | undefined): string {
  const lines = [
    '  id: number;',
    '  date: string;',
    '  date_gmt: string;',
    '  modified: string;',
    '  modified_gmt: string;',
    '  slug: string;',
    "  status: 'publish' | 'future' | 'draft' | 'pending' | 'private';",
    `  type: ${JSON.stringify(target.postType)};`,
    '  link: string;',
    '  title: WpRendered;',
    '  content: WpRendered;',
    '  excerpt?: WpRendered;',
    '  featured_media: number;',
    '  template: string;',
    ...(target.hierarchical ? ['  parent: number;', '  menu_order: number;'] : []),
    ...target.taxonomyFields.map((field) => `  ${propertyName(field)}: number[];`),
    acfType ? `  acf: ${acfType};` : '  acf: Record<string, never> | [];',
  ];
  return `export interface ${typeName} {\n${lines.join('\n')}\n}`;
}

export interface GeneratedTypes {
  readonly code: string;
  readonly typeName: string;
}

/**
 * Generates TypeScript for a post type's REST response.
 * - "standard": matches ?acf_format=standard (needs acf-json).
 * - "light": matches the default response; from acf-json when available, else the REST route schema.
 */
export function generateTypes(
  target: TypeTarget,
  source:
    | { readonly from: 'acf-json'; readonly format: AcfFormat; readonly fields: AcfFieldDef[] }
    | { readonly from: 'rest-schema'; readonly format: 'light'; readonly schema: JsonSchemaProperty | undefined },
): GeneratedTypes {
  const typeName = pascalCase(target.postType) || 'Post';
  const collector = new Collector();

  let acfType: string | undefined;
  if (source.from === 'acf-json' && source.fields.length > 0) {
    acfType = objectInterface(`${typeName}Acf`, source.fields, collector, source.format);
  } else if (
    source.from === 'rest-schema' &&
    source.schema?.properties &&
    Object.keys(source.schema.properties).length > 0
  ) {
    acfType = fromJsonSchema(source.schema, `${typeName}Acf`, collector);
  } else if (source.from === 'rest-schema') {
    // The REST schema lists no fields (for example, groups placed by page template): stay permissive.
    acfType = 'Record<string, unknown>';
  }

  const request =
    source.format === 'standard'
      ? `GET /wp-json/wp/v2/<rest_base>?acf_format=standard`
      : `GET /wp-json/wp/v2/<rest_base> (default ACF format: IDs for images and related posts)`;

  const parts = [
    `// Generated by wp-headless-mcp for post type "${target.postType}".\n// Matches: ${request}`,
    'export interface WpRendered {\n  rendered: string;\n  protected?: boolean;\n}',
    ...[...collector.helpers].sort().map((helper) => HELPERS[helper] ?? ''),
    ...collector.interfaces,
    postInterface(target, typeName, acfType),
  ];

  return { code: `${parts.join('\n\n')}\n`, typeName };
}
