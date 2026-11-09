import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { basename } from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;

/** File types the media upload accepts. SVG is left out because it can carry scripts. */
const ALLOWED_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

export interface DownloadedFile {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  readonly filename: string;
}

function isPrivateIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Expands an IPv6 address into its 8 groups of 16 bits; an embedded dotted IPv4 tail becomes 2 groups. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().split('%')[0] ?? '';
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.split('.').map(Number);
    text = text.slice(0, -dotted.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((group) => parseInt(group || '0', 16));
}

/**
 * True for loopback, private, link-local, multicast, and other non-public addresses.
 * IPv6 forms that carry an IPv4 address (::ffff:7f00:1, ::127.0.0.1, 64:ff9b::/96) are
 * checked as that IPv4 address, because URL parsing rewrites them into hex groups.
 */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) !== 6) {
    return isPrivateIPv4(address);
  }
  const g = ipv6Groups(address);
  const embeddedV4 = (): string => `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((group) => group === 0);

  if (zeros(0, 8) || (zeros(0, 7) && g[7] === 1)) {
    return true; // :: and ::1
  }
  if ((zeros(0, 5) && g[5] === 0xffff) || zeros(0, 6) || (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6))) {
    return isPrivateIPv4(embeddedV4()); // IPv4-mapped, IPv4-compatible, NAT64
  }
  const first = g[0]!;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** Rejects URLs that aren't public http(s), so the server can't be used to reach internal hosts. */
async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs can be uploaded (got ${url.protocol}).`);
  }
  // URL keeps IPv6 literals in brackets ("[::1]"); IP literals need no DNS lookup.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(`Refusing to download from ${url.hostname}: it resolves to a private or local address.`);
  }
}

/** Downloads a file for the media library, with type, size, and redirect checks. */
export async function downloadForUpload(rawUrl: string, filenameOverride?: string): Promise<DownloadedFile> {
  let url = new URL(rawUrl);
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(url);
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    break;
  }

  if (!response || (response.status >= 300 && response.status < 400)) {
    throw new Error(`Too many redirects downloading ${rawUrl}.`);
  }
  if (!response.ok) {
    throw new Error(`Download failed: ${url.href} returned HTTP ${response.status}.`);
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = ALLOWED_TYPES[contentType];
  if (!extension) {
    throw new Error(
      `Unsupported file type "${contentType || 'unknown'}". Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}.`,
    );
  }

  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > MAX_BYTES) {
    throw new Error(`File is ${Math.round(declaredSize / 1024 / 1024)} MB; the limit is 10 MB.`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error('File is larger than the 10 MB limit.');
  }

  const fromUrl = basename(url.pathname) || 'upload';
  const base = (filenameOverride ?? fromUrl).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const filename = base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;

  return { bytes, contentType, filename };
}
