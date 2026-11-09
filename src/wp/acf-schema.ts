import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WpClient } from './client.js';
import type { SiteModel } from './site-model.js';

/** One ACF field definition, normalized from acf-json or the REST schema. */
export interface AcfFieldDef {
  readonly name: string;
  readonly label?: string;
  readonly type: string;
  readonly instructions?: string;
  readonly required?: boolean;
  readonly choices?: Record<string, string>;
  readonly postTypes?: string[];
  /** How ACF formats the value with acf_format=standard, e.g. "array", "url", "id", "object". */
  readonly returnFormat?: string;
  /** Select, post object, and user fields can hold several values. */
  readonly multiple?: boolean;
  readonly subFields?: AcfFieldDef[];
}

export interface AcfGroupDef {
  readonly key: string;
  readonly title: string;
  readonly showInRest: boolean;
  /** Location rules in words, one entry per OR branch, e.g. "post_type == project". */
  readonly location?: string[];
  readonly fields: AcfFieldDef[];
}

export interface AcfSchemaResult {
  readonly source: 'acf-json' | 'rest-schema';
  readonly groups: AcfGroupDef[];
}

/** What a field group's location rules are compared against. */
export interface AcfLocationTarget {
  readonly postType: string;
  readonly postId: number;
  readonly template: string;
}

interface AcfJsonRule {
  readonly param: string;
  readonly operator: string;
  readonly value: string;
}

interface AcfJsonField {
  readonly name: string;
  readonly label?: string;
  readonly type: string;
  readonly instructions?: string;
  readonly required?: number | boolean;
  readonly choices?: Record<string, string>;
  readonly post_type?: string[] | string;
  readonly return_format?: string;
  readonly multiple?: number | boolean;
  readonly sub_fields?: AcfJsonField[];
  readonly layouts?: Record<
    string,
    { readonly name: string; readonly label: string; readonly sub_fields?: AcfJsonField[] }
  >;
}

interface AcfJsonGroup {
  readonly key: string;
  readonly title: string;
  readonly active?: boolean | number;
  readonly show_in_rest?: number | boolean;
  readonly location?: AcfJsonRule[][];
  readonly fields?: AcfJsonField[];
}

export interface RestSchemaProperty {
  readonly type?: string | string[];
  readonly format?: string;
  readonly required?: boolean;
  readonly items?: RestSchemaProperty;
  readonly properties?: Record<string, RestSchemaProperty>;
}

/** Field types that are layout only and hold no value. */
const PRESENTATIONAL_TYPES = new Set(['tab', 'message', 'accordion']);

/**
 * Provides ACF field definitions for a post.
 * Prefers the theme's acf-json files (labels, field types, sub fields);
 * falls back to the REST route schema (names and JSON types only).
 */
export class AcfSchema {
  private groupsPromise: Promise<AcfJsonGroup[]> | undefined;

  public constructor(
    private readonly wp: WpClient,
    private readonly site: SiteModel,
    private readonly acfJsonPath: string | undefined,
  ) {}

  public get hasAcfJson(): boolean {
    return this.acfJsonPath !== undefined;
  }

  /** All field groups from acf-json, including ones that are not shown in REST. */
  public async allGroups(): Promise<AcfGroupDef[]> {
    return (await this.loadAcfJson()).map(toGroupDef);
  }

  /**
   * acf-json field groups that can apply to any item of a post type: groups with a
   * "post_type == <type>" rule, plus page-only rules (templates, specific pages) for pages.
   */
  public async groupsForPostType(postType: string): Promise<AcfGroupDef[]> {
    const groups = await this.loadAcfJson();
    return groups
      .filter((group) =>
        (group.location ?? []).some((andRules) =>
          andRules.some(
            (rule) =>
              (rule.param === 'post_type' && rule.operator === '==' && rule.value === postType) ||
              (postType === 'page' && ['page_template', 'page', 'page_type', 'page_parent'].includes(rule.param)) ||
              (postType === 'post' && ['post_template', 'post', 'post_category', 'post_format'].includes(rule.param)),
          ),
        ),
      )
      .map(toGroupDef);
  }

  /** The ACF part of a post type's REST schema (the default "light" format). */
  public async restSchema(postType: string): Promise<RestSchemaProperty | undefined> {
    const route = await this.site.postTypeRoute(postType);
    const res = await this.wp.options<{ schema?: { properties?: { acf?: RestSchemaProperty } } }>(route);
    return res.data.schema?.properties?.acf;
  }

  /** Field groups that apply to the given post, from acf-json or the REST schema. */
  public async forPost(target: AcfLocationTarget): Promise<AcfSchemaResult> {
    if (this.acfJsonPath) {
      const groups = (await this.loadAcfJson()).filter((group) => matchesLocation(group, target));
      return { source: 'acf-json', groups: groups.map(toGroupDef) };
    }
    return { source: 'rest-schema', groups: await this.fromRestSchema(target.postType) };
  }

  private async fromRestSchema(postType: string): Promise<AcfGroupDef[]> {
    const route = await this.site.postTypeRoute(postType);
    const res = await this.wp.options<{ schema?: { properties?: { acf?: RestSchemaProperty } } }>(route);
    const acf = res.data.schema?.properties?.acf?.properties;
    if (!acf) {
      return [];
    }
    return [
      {
        key: `rest:${postType}`,
        title: `ACF fields for ${postType} (from REST schema)`,
        showInRest: true,
        fields: Object.entries(acf).map(([name, prop]) => fromRestProperty(name, prop)),
      },
    ];
  }

  private async loadAcfJson(): Promise<AcfJsonGroup[]> {
    if (!this.acfJsonPath) {
      return [];
    }
    // Loaded once per process; acf-json only changes when field groups are edited.
    this.groupsPromise ??= this.readAcfJsonDir(this.acfJsonPath);
    return this.groupsPromise;
  }

  private async readAcfJsonDir(dir: string): Promise<AcfJsonGroup[]> {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
    } catch (error) {
      throw new Error(`Cannot read ACF_JSON_PATH "${dir}": ${(error as Error).message}`, { cause: error });
    }

    const groups = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as AcfJsonGroup),
    );
    return groups.filter((group) => group.key?.startsWith('group_') && group.active !== false && group.active !== 0);
  }
}

function toGroupDef(group: AcfJsonGroup): AcfGroupDef {
  return {
    key: group.key,
    title: group.title,
    showInRest: Boolean(group.show_in_rest),
    location: (group.location ?? []).map((andRules) =>
      andRules.map((rule) => `${rule.param} ${rule.operator} ${rule.value}`).join(' AND '),
    ),
    fields: (group.fields ?? []).filter((f) => !PRESENTATIONAL_TYPES.has(f.type)).map(fromAcfJsonField),
  };
}

function fromAcfJsonField(field: AcfJsonField): AcfFieldDef {
  const subFields =
    field.sub_fields ??
    // Flexible content: flatten layouts into pseudo sub fields so the structure stays visible.
    (field.layouts
      ? Object.values(field.layouts).map((layout) => ({
          name: layout.name,
          label: layout.label,
          type: 'layout',
          sub_fields: layout.sub_fields,
        }))
      : undefined);

  const postTypes = typeof field.post_type === 'string' ? [field.post_type] : field.post_type;

  return {
    name: field.name,
    ...(field.label ? { label: field.label } : {}),
    type: field.type,
    ...(field.instructions ? { instructions: field.instructions } : {}),
    ...(field.required ? { required: true } : {}),
    ...(field.choices && Object.keys(field.choices).length > 0 ? { choices: field.choices } : {}),
    ...(postTypes && postTypes.length > 0 ? { postTypes } : {}),
    ...(field.return_format ? { returnFormat: field.return_format } : {}),
    ...(field.multiple ? { multiple: true } : {}),
    ...(subFields
      ? { subFields: subFields.filter((f) => !PRESENTATIONAL_TYPES.has(f.type)).map(fromAcfJsonField) }
      : {}),
  };
}

function fromRestProperty(name: string, prop: RestSchemaProperty): AcfFieldDef {
  const types = Array.isArray(prop.type) ? prop.type.filter((t) => t !== 'null') : [prop.type ?? 'unknown'];
  const itemProps = prop.items?.properties ?? prop.properties;
  return {
    name,
    type: [types.join('|'), prop.format].filter(Boolean).join(':'),
    ...(prop.required ? { required: true } : {}),
    ...(itemProps
      ? { subFields: Object.entries(itemProps).map(([subName, subProp]) => fromRestProperty(subName, subProp)) }
      : {}),
  };
}

/**
 * ACF location rules: the outer array is OR, each inner array is AND.
 * Supports the rule params that can be checked from REST data; others never match.
 */
export function matchesLocation(group: AcfJsonGroup, target: AcfLocationTarget): boolean {
  return (group.location ?? []).some((andRules) => andRules.every((rule) => matchesRule(rule, target)));
}

function matchesRule(rule: AcfJsonRule, target: AcfLocationTarget): boolean {
  let actual: string;
  switch (rule.param) {
    case 'post_type':
      actual = target.postType;
      break;
    case 'page_template':
    case 'post_template':
      actual = target.template === '' ? 'default' : target.template;
      break;
    case 'page':
    case 'post':
      actual = String(target.postId);
      break;
    default:
      return false;
  }

  if (rule.operator === '==') {
    return actual === rule.value;
  }
  if (rule.operator === '!=') {
    return actual !== rule.value;
  }
  return false;
}
