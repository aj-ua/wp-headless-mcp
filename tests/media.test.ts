import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadForUpload, isPrivateAddress } from '../src/wp/media.js';

/** A public IP literal, so the address check needs no DNS lookup and the test needs no network. */
const PUBLIC = 'http://1.1.1.1';

function stubFetch(responses: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: string | URL) => {
    const handler = responses[String(input)];
    return Promise.resolve(handler ? handler() : new Response('not found', { status: 404 }));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadForUpload', () => {
  it('only accepts http and https', async () => {
    await expect(downloadForUpload('ftp://1.1.1.1/a.jpg')).rejects.toThrow(/Only http and https/);
  });

  it.each([
    'http://127.0.0.1/x.png',
    'http://10.0.0.5/x.png',
    'http://192.168.1.2/x.png',
    'http://169.254.169.254/x',
    'http://[::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
  ])('refuses private and local address %s', async (url) => {
    const fetch = stubFetch({});
    await expect(downloadForUpload(url)).rejects.toThrow(/private or local address/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('downloads an allowed image and fixes up the file name', async () => {
    stubFetch({
      [`${PUBLIC}/images/logo.png`]: () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
    });
    const file = await downloadForUpload(`${PUBLIC}/images/logo.png`, 'MCP test logo');
    expect(file).toMatchObject({ contentType: 'image/png', filename: 'MCP-test-logo.png' });
    expect(file.bytes.byteLength).toBe(3);
  });

  it('rejects other content types, including SVG', async () => {
    stubFetch({
      [`${PUBLIC}/page`]: () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
      [`${PUBLIC}/a.svg`]: () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    });
    await expect(downloadForUpload(`${PUBLIC}/page`)).rejects.toThrow(/Unsupported file type "text\/html"/);
    await expect(downloadForUpload(`${PUBLIC}/a.svg`)).rejects.toThrow(/Unsupported file type "image\/svg\+xml"/);
  });

  it('rejects files over 10 MB by declared size', async () => {
    stubFetch({
      [`${PUBLIC}/big.jpg`]: () =>
        new Response('x', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(20 * 1024 * 1024) } }),
    });
    await expect(downloadForUpload(`${PUBLIC}/big.jpg`)).rejects.toThrow(/limit is 10 MB/);
  });

  it('checks every redirect hop against the address rules', async () => {
    const fetch = stubFetch({
      [`${PUBLIC}/redirect`]: () =>
        new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret.png' } }),
    });
    await expect(downloadForUpload(`${PUBLIC}/redirect`)).rejects.toThrow(/private or local address/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops after too many redirects', async () => {
    stubFetch({
      [`${PUBLIC}/loop`]: () => new Response(null, { status: 302, headers: { Location: `${PUBLIC}/loop` } }),
    });
    await expect(downloadForUpload(`${PUBLIC}/loop`)).rejects.toThrow(/Too many redirects/);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.20.0.1', true],
    ['100.64.0.1', true],
    ['8.8.8.8', false],
    ['::1', true],
    ['::', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['ff02::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:a00:1', true],
    ['::ffff:808:808', false],
    ['::7f00:1', true],
    ['64:ff9b::7f00:1', true],
    ['64:ff9b::808:808', false],
    ['2606:4700:4700::1111', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});
