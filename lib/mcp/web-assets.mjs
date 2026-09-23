const DEFAULT_MAX_BYTES = 500_000;
const HARD_MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 4;
const ALLOWED_PORTS = new Set(['', '80', '443']);

function parseIpv4(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const octets = hostname.split('.').map(Number);
  return octets.every(value => value >= 0 && value <= 255) ? octets : null;
}

function isPrivateIpv4(octets) {
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

export function validatePublicHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('url must be a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url must use http or https');
  if (url.username || url.password) throw new Error('url must not contain credentials');
  if (!ALLOWED_PORTS.has(url.port)) throw new Error('url may only use port 80 or 443');

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.lan')) {
    throw new Error('url must target a public host');
  }
  const ipv4 = parseIpv4(hostname);
  if (ipv4 && isPrivateIpv4(ipv4)) throw new Error('url must not target a private or reserved address');
  const isIpv6 = hostname.includes(':');
  if (isIpv6 && (hostname === '::' || hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe8') || hostname.startsWith('fe9') || hostname.startsWith('fea') || hostname.startsWith('feb') || hostname.startsWith('::ffff:'))) {
    throw new Error('url must not target a private or reserved address');
  }
  return url;
}

function normalizeMaxBytes(value) {
  if (value == null) return DEFAULT_MAX_BYTES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > HARD_MAX_BYTES) {
    throw new Error(`maxBytes must be an integer between 1 and ${HARD_MAX_BYTES}`);
  }
  return parsed;
}

function isReadableText(contentType, url) {
  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  if (['application/json', 'application/ld+json', 'application/manifest+json', 'application/xml', 'application/xhtml+xml', 'image/svg+xml'].includes(type)) return true;
  return /\.(?:svg|xml|json|webmanifest|html?|txt)$/i.test(url.pathname);
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`resource exceeds ${maxBytes} bytes`);
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`resource exceeds ${maxBytes} bytes`);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
}

export async function fetchPublicResourceText(value, options = {}) {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const fetchImpl = options.fetchImpl || fetch;
  let url = validatePublicHttpUrl(value);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(url.toString(), {
      redirect: 'manual',
      headers: {
        Accept: 'image/svg+xml,text/html,application/xhtml+xml,application/manifest+json,application/json,application/xml,text/plain;q=0.9,*/*;q=0.1',
        'User-Agent': 'RainForest-Navigator-MCP/2.4',
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect response did not include a location');
      if (redirects === MAX_REDIRECTS) throw new Error('resource exceeded the redirect limit');
      url = validatePublicHttpUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`resource request failed with HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    if (!isReadableText(contentType, url)) {
      throw new Error(`resource is not readable text (${contentType || 'unknown content type'})`);
    }
    const body = await readBoundedText(response, maxBytes);
    return {
      requestedUrl: String(value),
      finalUrl: url.toString(),
      status: response.status,
      contentType: contentType || 'text/plain',
      bytes: new TextEncoder().encode(body).byteLength,
      body,
    };
  }
  throw new Error('resource exceeded the redirect limit');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function absoluteUrl(value, baseUrl) {
  if (!value || /^(?:data|javascript):/i.test(value)) return null;
  try {
    return validatePublicHttpUrl(new URL(value, baseUrl).toString()).toString();
  } catch {
    return null;
  }
}

function addCandidate(candidates, seen, candidate) {
  if (!candidate.url || seen.has(candidate.url)) return;
  seen.add(candidate.url);
  candidates.push(candidate);
}

export async function inspectWebsiteIconAssets(value, options = {}) {
  const page = await fetchPublicResourceText(value, { ...options, maxBytes: options.maxBytes || HARD_MAX_BYTES });
  if (!/html|xhtml/i.test(page.contentType) && !/<html[\s>]/i.test(page.body)) {
    throw new Error('website inspection requires an HTML document');
  }

  const candidates = [];
  const seen = new Set();
  for (const match of page.body.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1]);
    const rel = (attributes.rel || '').toLowerCase();
    if (!/(?:^|\s)(?:icon|shortcut|apple-touch-icon|mask-icon|manifest)(?:\s|$)/.test(rel)) continue;
    const url = absoluteUrl(attributes.href, page.finalUrl);
    addCandidate(candidates, seen, {
      kind: rel.includes('manifest') ? 'manifest' : 'linked-icon',
      url,
      rel,
      type: attributes.type || '',
      sizes: attributes.sizes || '',
    });
  }

  for (const match of page.body.matchAll(/<img\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1]);
    const identity = [attributes.alt, attributes.id, attributes.class, attributes.src].join(' ');
    if (!/(?:logo|brand|icon|mark)/i.test(identity)) continue;
    const url = absoluteUrl(attributes.src || attributes['data-src'], page.finalUrl);
    addCandidate(candidates, seen, {
      kind: 'brand-image',
      url,
      alt: attributes.alt || '',
      type: '',
      sizes: '',
    });
    if (candidates.length >= 40) break;
  }

  const inlineSvgs = [];
  for (const match of page.body.matchAll(/<svg\b[\s\S]*?<\/svg\s*>/gi)) {
    const svg = match[0];
    if (svg.length > 120_000) continue;
    const context = page.body.slice(Math.max(0, match.index - 300), match.index + Math.min(svg.length, 300));
    const score = (/(?:logo|brand|home|navbar|header)/i.test(context) ? 3 : 0)
      + (/<(?:path|polygon|circle|rect)\b/i.test(svg) ? 1 : 0)
      + (/viewBox=/i.test(svg) ? 1 : 0);
    inlineSvgs.push({ index: inlineSvgs.length, score, svg });
    if (inlineSvgs.length >= 16) break;
  }
  inlineSvgs.sort((a, b) => b.score - a.score);

  const manifest = candidates.find(candidate => candidate.kind === 'manifest');
  let manifestIcons = [];
  let manifestError = '';
  if (manifest) {
    try {
      const resource = await fetchPublicResourceText(manifest.url, { ...options, maxBytes: 250_000 });
      const data = JSON.parse(resource.body);
      manifestIcons = Array.isArray(data.icons) ? data.icons.slice(0, 30).map(icon => ({
        kind: 'manifest-icon',
        url: absoluteUrl(icon.src, resource.finalUrl),
        type: String(icon.type || ''),
        sizes: String(icon.sizes || ''),
        purpose: String(icon.purpose || ''),
      })).filter(icon => icon.url) : [];
      for (const icon of manifestIcons) addCandidate(candidates, seen, icon);
    } catch (error) {
      manifestError = error instanceof Error ? error.message : 'manifest could not be read';
    }
  }

  const title = decodeHtml(page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  return {
    pageUrl: page.finalUrl,
    title,
    candidates,
    inlineSvgs,
    manifestError,
  };
}
