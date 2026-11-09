import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AcfSchema } from '../src/wp/acf-schema.js';
import { SiteModel } from '../src/wp/site-model.js';
import { generateTypes, pascalCase, type AcfFormat } from '../src/wp/ts-types.js';
import { ACF_JSON_DIR, FIXTURES, fakeWp } from './helpers.js';

const { wp } = fakeWp({});
const schema = new AcfSchema(wp, new SiteModel(wp), ACF_JSON_DIR);

async function typesFor(postType: string, format: AcfFormat, hierarchical = false): Promise<string> {
  const groups = await schema.groupsForPostType(postType);
  return generateTypes(
    { postType, hierarchical, taxonomyFields: [] },
    { from: 'acf-json', format, fields: groups.flatMap((group) => group.fields) },
  ).code;
}

/** Compiles generated types together with recorded REST data, strict mode. Returns error messages. */
function compileAgainst(code: string, typeName: string, data: unknown): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'wp-headless-mcp-types-'));
  writeFileSync(join(dir, 'types.ts'), code);
  // Only the fields the interface describes, so excess-property checks apply to everything else.
  writeFileSync(
    join(dir, 'check.ts'),
    `import type { ${typeName} } from './types';\nexport const data: Pick<${typeName}, 'id' | 'type' | 'link' | 'acf'>[] = ${JSON.stringify(data)};\n`,
  );
  const program = ts.createProgram([join(dir, 'check.ts')], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

function recorded(name: string): Record<string, unknown>[] {
  const data = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
  const items = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
  return items.map(({ id, type, link, acf }) => ({ id, type, link, acf }));
}

describe('pascalCase', () => {
  it('turns post type slugs into type names', () => {
    expect(pascalCase('project')).toBe('Project');
    expect(pascalCase('case-study')).toBe('CaseStudy');
  });
});

describe('generateTypes from acf-json', () => {
  it('types the project repeater, images, and labels in standard format', async () => {
    const code = await typesFor('project', 'standard');
    expect(code).toContain('export interface ProjectAcfImagesRow {');
    expect(code).toContain('/** Images (repeater) */');
    // Empty repeaters come back as false with acf_format=standard.
    expect(code).toContain('images: ProjectAcfImagesRow[] | false | null;');
    expect(code).toContain('image: AcfImage | false | null;');
    expect(code).toContain('subtitle: string | null;');
    expect(code).toContain('export interface AcfImage {');
  });

  it('uses IDs for images and related posts in light format', async () => {
    expect(await typesFor('project', 'light')).toContain('image: number | null;');
    const page = await typesFor('page', 'light', true);
    expect(page).toContain('portfolio: number[] | null;');
    expect(page).toContain('parent: number;');
  });

  it('includes page-template groups for pages, and nothing for posts on aj-ua', async () => {
    expect(await typesFor('page', 'standard', true)).toContain('portfolio: AcfPostObject[] | false | null;');
    expect(await typesFor('post', 'standard')).toContain('acf: Record<string, never> | [];');
  });

  it('produces types that real aj-ua responses satisfy, in both formats', async () => {
    expect(
      compileAgainst(await typesFor('project', 'standard'), 'Project', recorded('projects-standard.json')),
    ).toEqual([]);
    expect(compileAgainst(await typesFor('project', 'light'), 'Project', recorded('project-light.json'))).toEqual([]);
    expect(
      compileAgainst(await typesFor('page', 'standard', true), 'Page', recorded('home-page-standard.json')),
    ).toEqual([]);
  }, 30_000);

  it('rejects data in the wrong format', async () => {
    const errors = compileAgainst(await typesFor('project', 'standard'), 'Project', recorded('project-light.json'));
    expect(errors.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('generateTypes from the REST schema', () => {
  it('maps JSON schema types and stays permissive when the schema lists no fields', () => {
    const fromSchema = generateTypes(
      { postType: 'project', hierarchical: false, taxonomyFields: ['tags'] },
      {
        from: 'rest-schema',
        format: 'light',
        schema: {
          type: 'object',
          properties: {
            subtitle: { type: ['string', 'null'] },
            images: {
              type: ['array', 'null'],
              items: { type: 'object', properties: { image: { type: ['integer', 'null'] } } },
            },
          },
        },
      },
    ).code;
    expect(fromSchema).toContain('subtitle: string | null;');
    expect(fromSchema).toContain('image: number | null;');
    expect(fromSchema).toContain('tags: number[];');

    const empty = generateTypes(
      { postType: 'page', hierarchical: true, taxonomyFields: [] },
      { from: 'rest-schema', format: 'light', schema: { type: 'object', properties: {} } },
    ).code;
    expect(empty).toContain('acf: Record<string, unknown>;');
  });
});
