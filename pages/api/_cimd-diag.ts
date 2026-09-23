import type { NextApiRequest, NextApiResponse } from 'next';

// TEMPORARY diagnostic. Reports which request-header combination can fetch the
// ChatGPT CIMD document from this deployment's egress network. Only the fixed
// public URL below is requested, and only status codes are returned.
// Remove this route once the CIMD fetch headers are settled.
const TARGET = 'https://chatgpt.com/oauth/client.json';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const VARIANTS: { label: string; headers: Record<string, string> }[] = [
  { label: 'accept-only', headers: { Accept: 'application/json' } },
  {
    label: 'identified-ua',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'RainForest-Navigator-MCP/1.0 (+https://nav.rainforest.org.cn)',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
  {
    label: 'chrome-ua',
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9' },
  },
  { label: 'curl-ua', headers: { Accept: 'application/json', 'User-Agent': 'curl/8.7.1' } },
  {
    label: 'chrome-ua-full',
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Dest': 'empty',
    },
  },
];

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  const results: Record<string, unknown>[] = [];
  for (const variant of VARIANTS) {
    try {
      const response = await fetch(TARGET, { redirect: 'manual', headers: variant.headers });
      const body = await response.text().catch(() => '');
      results.push({
        label: variant.label,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        bytes: body.length,
        server: response.headers.get('server') || '',
        cfRay: response.headers.get('cf-ray') ? 'present' : '',
        snippet: body.slice(0, 80),
      });
    } catch (error) {
      results.push({ label: variant.label, error: error instanceof Error ? error.message : 'request failed' });
    }
  }

  res.status(200).json({ target: TARGET, results });
}
