import { describe, expect, it } from 'vitest';
import { AcfSchema, matchesLocation } from '../src/wp/acf-schema.js';
import { SiteModel } from '../src/wp/site-model.js';
import { ACF_JSON_DIR, fakeWp } from './helpers.js';

function schemaWith(dir: string | undefined, routes: Record<string, unknown> = {}): AcfSchema {
  const { wp } = fakeWp(routes);
  return new AcfSchema(wp, new SiteModel(wp), dir);
}

describe('matchesLocation', () => {
  const group = {
    key: 'group_x',
    title: 'X',
    location: [
      [{ param: 'post_type', operator: '==', value: 'project' }],
      [
        { param: 'page_template', operator: '==', value: 'page-templates/home.php' },
        { param: 'page', operator: '!=', value: '9' },
      ],
    ],
  };

  it('treats outer rules as OR and inner rules as AND', () => {
    expect(matchesLocation(group, { postType: 'project', postId: 1, template: '' })).toBe(true);
    expect(matchesLocation(group, { postType: 'page', postId: 4, template: 'page-templates/home.php' })).toBe(true);
    expect(matchesLocation(group, { postType: 'page', postId: 9, template: 'page-templates/home.php' })).toBe(false);
    expect(matchesLocation(group, { postType: 'page', postId: 4, template: '' })).toBe(false);
  });

  it('never matches rule params it cannot check from REST data', () => {
    const options = { key: 'g', title: 'O', location: [[{ param: 'options_page', operator: '==', value: 'x' }]] };
    expect(matchesLocation(options, { postType: 'page', postId: 1, template: '' })).toBe(false);
  });
});

describe('AcfSchema with acf-json', () => {
  const schema = schemaWith(ACF_JSON_DIR);

  it('loads all field groups, skipping tabs and messages', async () => {
    const groups = await schema.allGroups();
    expect(groups.map((group) => group.title).sort()).toEqual(['Home Page', 'Project Page', 'Theme Options']);
    const options = groups.find((group) => group.title === 'Theme Options')!;
    expect(options.fields.map((field) => field.type)).not.toContain('tab');
    expect(options.location).toEqual(['options_page == theme-general-settings']);
  });

  it('reads labels, return formats, and sub fields', async () => {
    const [project] = await schema.groupsForPostType('project');
    const images = project!.fields.find((field) => field.name === 'images')!;
    expect(images.label).toBe('Images');
    expect(images.subFields?.find((field) => field.name === 'image')?.returnFormat).toBe('array');
  });

  it('matches the Home Page group by template for one post', async () => {
    const result = await schema.forPost({ postType: 'page', postId: 4, template: 'page-templates/home.php' });
    expect(result.source).toBe('acf-json');
    expect(result.groups.map((group) => group.title)).toEqual(['Home Page']);
  });

  it('explains a wrong ACF_JSON_PATH', async () => {
    await expect(schemaWith('/nonexistent/acf-json').allGroups()).rejects.toThrow(/Cannot read ACF_JSON_PATH/);
  });
});

describe('AcfSchema without acf-json', () => {
  it('falls back to the REST route schema', async () => {
    const schema = schemaWith(undefined, {
      'OPTIONS wp/v2/project': {
        schema: { properties: { acf: { type: 'object', properties: { subtitle: { type: ['string', 'null'] } } } } },
      },
    });
    const result = await schema.forPost({ postType: 'project', postId: 310, template: '' });
    expect(result.source).toBe('rest-schema');
    expect(result.groups[0]!.fields).toEqual([{ name: 'subtitle', type: 'string' }]);
  });
});
