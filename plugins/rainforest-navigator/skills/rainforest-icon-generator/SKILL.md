---
name: rainforest-icon-generator
description: Create or replace RainForest Navigator website icons as standardized 64×64 SVGs from a domain, URL, official SVG, or bitmap reference. Use for finding official brand symbols, fitting them into the RainForest template, and optionally applying them through RainForest MCP.
---

# RainForest Icon Generator

Produce a faithful, editable SVG icon for RainForest Navigator. Preserve the official brand mark; this workflow normalizes assets rather than redesigning brands.

## Required template

Every result starts from this exact template:

```svg
<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="3" y="3" width="58" height="58" rx="20" fill="#E8EAED"/>
</svg>
```

The `64×64` canvas and base rectangle geometry are immutable. Keep the base `<rect>` as the first visual element. Its `fill` may change only when an official brand-color background or complete app-icon treatment clearly calls for it; otherwise keep `#E8EAED`.

## Non-negotiable rules

- Prefer an official symbol, favicon, or app icon over a wordmark.
- Use official-site assets before GitHub mirrors, icon libraries, search-result copies, or hand reconstruction.
- When an official vector exists, preserve its paths and proportions. Remove only metadata, text/wordmark elements the user does not want, and presentation attributes that do not define the mark.
- Do not redraw a logo from memory or substitute a generic related icon.
- Do not embed PNG, JPEG, or WebP data in the final SVG. If only a bitmap exists, vectorize it faithfully when the artwork is suitable. If faithful vectorization is not possible, stop and request a better official asset or user guidance.
- Never claim an icon was applied unless a write tool succeeded and a read-back confirms the target entry changed.

## Workflow

### 1. Resolve the target and capability

Identify the canonical domain, exact product, and matching RainForest entry. Check whether the current environment can browse raw page assets, read SVG text, render/inspect files, and write through RainForest MCP.

When using RainForest MCP, begin with `extension_get_icon_generation_guide` and retain the returned `skillDigest`. Every generated-icon write must pass that exact digest; if it is rejected as stale, read the guide again before continuing.

If the user asked only to generate, do not mutate navigation data. If the user asked to apply the icon, resolve the exact entry UUID before writing; ask only when multiple entries remain ambiguous.

### 2. Acquire the official mark

Inspect sources in this order:

1. inline SVG in the official site's rendered header/navigation;
2. official SVG favicon or Web App Manifest icon;
3. official brand, press, download, or design-system page;
4. official external SVG URL referenced by the site;
5. highest-resolution official bitmap, only after vector sources are exhausted.

With RainForest MCP, use the built-in acquisition tools in this order:

1. call `inspect_website_icon_assets` on the official page;
2. call `fetch_public_resource_text` for a discovered SVG, manifest, XML, JSON, or HTML URL so `image/svg+xml` is returned as source text;
3. when the logo exists only after client rendering, call `extension_extract_rendered_page_assets` to inspect the browser's final DOM;
4. use the exact official asset URL returned by those tools as `sourceUrl`.

A semantic webpage reader may omit DOM attributes, inline SVG paths, client-rendered content, or the body of an `image/svg+xml` response. An empty extraction does **not** prove that no SVG exists. Use raw-resource, rendered-DOM, browser-development, or HTTP-text capabilities when available.

If an official SVG URL is confirmed but the available tools cannot read its XML:

1. provide that exact official URL;
2. explain that the tool cannot retrieve the SVG source;
3. ask the user to open it and paste the complete `<svg>...</svg>` source;
4. do not replace it with a PNG or approximate redraw.

For source discovery, inspect the rendered official page near its home link, header, navigation, logo, and brand mark. When a URL ends in `.svg` or responds as `image/svg+xml`, retrieve its body as text rather than treating it as a raster image. Use an official organization repository only when the official site points to it or no first-party site asset exists. Record the source URL and whether it was inline SVG, linked SVG, or bitmap.

### 3. Prepare the mark

For official SVG:

- retain the original `path`, `circle`, `rect`, `polygon`, `polyline`, and gradient geometry;
- remove framework-only attributes such as `class`, `aria-hidden`, and `data-*`;
- remove wordmark/text portions only when the target is the standalone symbol;
- replace `currentColor` only after choosing a contrast-safe official color treatment;
- fit using a wrapper transform rather than editing path coordinates.

For bitmap-only artwork:

- use the largest official source;
- trim blank margins and upscale only for inspection/tracing;
- trace simple, flat artwork and compare it against the source;
- never invent hidden detail;
- do not output a bitmap embedded inside SVG.

### 4. Fit into RainForest

Start with an approximately `40×40` visual area at `x=12`, `y=12`. Preserve aspect ratio and use optical centering.

- square/full marks: about 38–40 px;
- round or tall marks: about 40–42 px;
- wide or triangular marks: about 42–44 px;
- thin marks: up to about 44 px.

Keep artwork inside the base region `3..61`. Do not stretch, add arbitrary shadows or outlines, or round the brand artwork itself.

Color priority:

1. preserve a complete official app-icon treatment;
2. use an official brand-color base with a white mark when an official monochrome/inverse mark supports it;
3. retain multicolor artwork on the neutral `#E8EAED` base.

### 5. Validate before applying

Confirm all of the following:

- exact 64×64 root canvas;
- base rectangle `x=3 y=3 width=58 height=58 rx=20` exists;
- correct official source and product identity;
- no wordmark remains when a symbol-only icon was requested;
- proportions and original path geometry are preserved;
- no clipping, external URLs, scripts, event handlers, or embedded bitmap data;
- the icon remains legible at 64×64 and visually centered.

Generate a 512×512 preview when the environment supports rendering. Do not claim visual verification if only structural validation was possible.

### 6. Apply and verify

When authorized to update navigation:

1. for a new browser-extension entry, default to `extension_add_navigation_entry_with_icon` so the entry and compliant SVG are committed together; use bare `extension_add_navigation_entry` only when the user explicitly requests no generated icon;
2. for an existing entry, call `set_navigation_icon` for the online site or `extension_generate_navigation_icon` for browser-extension data;
3. send the exact UUID when applicable, complete SVG, stable filename, official `sourceUrl`, truthful `sourceRoute`, and current `skillDigest`;
4. read the entry again;
5. report success only if the write succeeded and `iconUrl` changed.

If no compatible write tool is present, return the final SVG and exact target UUID without saying it was installed.

## Batch requests

Process entries one at a time. For each entry, finish source verification, template fitting, validation, and optional write/read-back before moving to the next. Do not silently apply one guessed treatment across the whole batch.

## Reference SVGs

Use these only as composition references. Do not copy their brand paths for a different website.

Neutral-base example:

```svg
<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="3" width="58" height="58" rx="20" fill="#E8EAED"/>
  <g id="brand-icon" transform="translate(-47.46 4.15) scale(0.885)">
    <path fill="#2932E1" d="M104.18,37.45c-1.17-1.11-4.42-3.31-6.9-7.4a8.51,8.51,0,0,0-15,0c-2.47,4.09-5.73,6.29-6.9,7.4-1.47,1.39-7.68,4.69-6.33,11.9a8.91,8.91,0,0,0,8.08,7.43,28.07,28.07,0,0,0,8.58-1,18.54,18.54,0,0,1,8.12,0,28.12,28.12,0,0,0,8.59,1,8.89,8.89,0,0,0,8.07-7.43C111.86,42.14,105.65,38.84,104.18,37.45Z"/>
    <path fill="#2932E1" d="M73,33.25c3.69-.51,5-4.28,4.6-7.9-.33-3.2-2.48-6.85-6-6.53S66,22.48,66.05,26.41C66.08,30.15,68.67,33.84,73,33.25Z"/>
    <path fill="#2932E1" d="M83.26,21.58c3.66-.34,5-4.09,4.87-7.78C88,9.75,85.81,6.5,82.31,6.68c-3.12.17-5.64,3.3-5.76,7.46C76.41,18.5,79.2,22,83.26,21.58Z"/>
    <path fill="#2932E1" d="M106.63,33.25c-3.7-.51-5-4.28-4.61-7.9.33-3.2,2.49-6.85,6-6.53s5.51,3.66,5.49,7.59C113.51,30.15,110.91,33.84,106.63,33.25Z"/>
    <path fill="#2932E1" d="M96.32,21.58c-3.66-.34-5-4.09-4.87-7.78.1-4.05,2.32-7.3,5.83-7.12,3.11.17,5.63,3.3,5.76,7.46C103.17,18.5,100.38,22,96.32,21.58Z"/>
    <path fill="#FFFFFF" d="M86.79,48.81H81.56a2.91,2.91,0,0,1-2.92-3,2.85,2.85,0,0,1,2.83-3h5.11V39.38H81.49a6.12,6.12,0,0,0-6.34,6.3c0,3.84,2.4,6.54,6.57,6.54h5.07Z"/>
    <path fill="#FFFFFF" d="M90.71,39.27h3.41v7.94c0,1.24.49,1.6,1.14,1.6h3.53V39.27h3.43V52.22H95c-2.94,0-4.27-1.58-4.27-3.91Z"/>
    <polygon fill="#FFFFFF" points="88.01 52.22 88.01 33.92 88.01 33.92 84.49 33.92 84.49 33.92 84.48 52.22 88.01 52.22 88.01 52.22"/>
  </g>
</svg>
```

Official-brand-background example:

```svg
<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="3" width="58" height="58" rx="20" fill="#FF5000"/>
  <g id="brand-icon" fill="#FFFFFF" transform="translate(10.75 0) scale(3.65)">
    <path d="M1.8822 6.4166c.5515 0 .9985-.449.9985-1 0-.5531-.447-.9995-.9985-.9995a.9984.9984 0 00-1.001.9995c0 .551.4463 1 1.001 1z"/>
    <path d="M5.2916 5.557c.252-.4364.3717-.7195.3717-.7195l-1.466-.4123S3.6068 6.3546 2.5527 7.253c0 0 1.0195.5897 1.0095.5732a9.6444 9.6444 0 00.782-.8793c.2345-.1017.4585-.198.6794-.2876-.2715.487-.7094 1.219-1.1478 1.6809l.6178.5385s.4198-.4033.8792-.8907h.5246v.8993H3.8557v.7204h2.0416v1.7235c-.025 0-.0521 0-.0782-.002-.224-.0106-.5751-.0476-.7124-.265-.1678-.2636-.044-.7496-.0346-1.0457H3.6608l-.0496.026s-.517 2.3142 1.489 2.2621c1.8793.0521 2.9544-.523 3.4725-.9178l.2064.7645 1.1583-.4825-.785-1.9183-.941.292.1764.6574c-.2415.1809-.518.3157-.8187.4134V9.6076h1.995v-.7204h-1.995v-.8993h2.003v-.72h-3.557c.2565-.3111.4589-.5982.5095-.78L5.9058 6.32c2.6603-.9519 4.1408-.7886 4.1278.773v4.1128s.1568 1.4124-1.461 1.3107l-.8757-.188-.207.8307s3.7822 1.0812 4.0913-1.8246c.3096-2.9058-.0767-4.7576-.0767-4.7576s-.3451-2.6824-6.213-1.02z"/>
    <path d="M.0582 12.1534l1.5867.9905c1.0967-2.3813 1.0265-2.0657 1.302-2.92.2832-.8737.3453-1.54-.1362-2.023-.6172-.6197-.6844-.6773-1.6017-1.3582L.5487 7.8562l1.2164.7576s.8141.4153.4274 1.1903c-.3617.7375-2.1343 2.3493-2.1343 2.3493z"/>
  </g>
</svg>
```

## Response

Keep the user-facing response concise. State:

- which official source route was used;
- whether the result was generated only or actually applied and verified;
- any source limitation requiring user-supplied SVG code.

Use one truthful route label: `官方矢量直接适配`, `官方位图矢量化`, or `等待官方 SVG 源码`.
