// Empirical probe for Vercel Blob semantics on the version this project pins.
// Verifies the assumptions the online MCP auth control plane depends on:
//   1. does addRandomSuffix:false overwrite in place, or create a second object?
//   2. is cacheControlMaxAge:0 honoured, or silently normalized?
//   3. after an overwrite, does fetching the blob URL return fresh content?
// Run: node --env-file=.env.local test/blob-semantics.mjs
import { del, head, list, put } from '@vercel/blob';

const FRESH_PATH = 'mcp-settings/__probe-fresh.json';
const DEFAULT_PATH = 'mcp-settings/__probe-default.json';
const ACCESS = { access: 'public', contentType: 'application/json', addRandomSuffix: false };
const NO_CACHE = { ...ACCESS, cacheControlMaxAge: 0 };

async function readByPath(path) {
  const { blobs } = await list({ prefix: path });
  const matches = blobs
    .filter(blob => blob.pathname === path)
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  if (!matches.length) return { value: null, objects: 0 };
  const response = await fetch(matches[0].url, { cache: 'no-store' });
  return {
    value: await response.json(),
    objects: matches.length,
    url: matches[0].url,
    cacheControl: response.headers.get('cache-control'),
    age: response.headers.get('age'),
    uploadedAt: matches[0].uploadedAt.toISOString(),
  };
}

async function probe(label, path, options) {
  console.log(`\n=== ${label} ===`);
  const first = await put(path, JSON.stringify({ version: 1 }), options);
  const afterFirst = await readByPath(path);
  console.log(`写入 v1 → 读到 v${afterFirst.value?.version}, 同 pathname 对象数=${afterFirst.objects}`);

  const second = await put(path, JSON.stringify({ version: 2 }), options);
  console.log(`URL 是否稳定: ${first.url === second.url ? '稳定（原地覆盖）' : '变化（生成了新对象）'}`);
  console.log(`  写入1 pathname: ${new URL(first.url).pathname}`);
  console.log(`  写入2 pathname: ${new URL(second.url).pathname}`);

  const observed = [];
  const startedAt = Date.now();
  let flipMs = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const read = await readByPath(path);
    observed.push(read.value?.version);
    if (read.value?.version === 2 && flipMs === null) flipMs = Date.now() - startedAt;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const final = await readByPath(path);
  console.log(`覆盖 v2 后连续 10 次读取: [${observed.join(', ')}]`);
  console.log(`首个看到 v2 的耗时: ${flipMs === null ? '10 次均未看到（严重）' : flipMs + 'ms'}`);
  console.log(`最终同 pathname 对象数=${final.objects}, cache-control=${final.cacheControl}, age=${final.age}`);

  const headInfo = await head(second.url);
  console.log(`head(): uploadedAt=${headInfo.uploadedAt.toISOString()}, etag=${headInfo.etag}`);

  return { observed, flipMs, objects: final.objects, urlStable: first.url === second.url, cacheControl: final.cacheControl };
}

const fresh = await probe('启用 cacheControlMaxAge: 0', FRESH_PATH, NO_CACHE);
const dflt = await probe('不传 cacheControlMaxAge（SDK 默认 1 年）', DEFAULT_PATH, ACCESS);

console.log('\n=== 结论 ===');
console.log(`原地覆盖: ${fresh.urlStable && dflt.urlStable ? '是' : '否'}`);
console.log(`cacheControlMaxAge:0 生效: ${fresh.cacheControl === 'no-cache' || fresh.cacheControl === 'no-cache, no-store' ? '是' : `返回 "${fresh.cacheControl}"`}`);
console.log(`默认缓存头: "${dflt.cacheControl}"`);
console.log(`覆盖立即可读: fresh=${fresh.flipMs === null ? '否' : '是'} default=${dflt.flipMs === null ? '否' : '是'}`);
console.log(`同 pathname 是否出现多对象: fresh=${fresh.objects}, default=${dflt.objects}`);

await del(FRESH_PATH);
await del(DEFAULT_PATH);
console.log('\n探针对象已清理。');
