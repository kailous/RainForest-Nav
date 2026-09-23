# RainForest Navigator Plugin

This directory is the portable ChatGPT/Codex plugin package. The browser extension owns the data and executes operations; the deployable relay source lives in the repository-level `mcp/` directory.

This package connects to the browser-extension MCP through a cloud relay. It operates only on extension IndexedDB data and never routes calls to the website database.

- Remote MCP endpoint: `https://mcp.nav.rainforest.org.cn/mcp`
- ChatGPT web authentication: OAuth 2.1 authorization code + PKCE.
- Local Codex compatibility authentication: `RAINFOREST_EXTENSION_TOKEN`.
- Copy the pairing key from the extension's independent **MCP** page when the authorization page asks for it.
- No terminal window or local Node.js server is required.

The deployed website has its own independent Streamable HTTP MCP endpoint at `/api/mcp`. It is a separate deployment with its own authorization server, its own data store (Vercel Blob) and its own credentials. Calls are never routed between the two.

Credential isolation is deliberate — three credentials exist and none of them works in another's place:

| Credential | Belongs to | Works only against |
|---|---|---|
| Plugin access key (generated locally in the extension) | Browser extension | Extension MCP |
| Online MCP key (`rfn_live_*`, generated in the site admin) | Website | Online MCP |
| Admin login password | Website | Website admin console |

The extension MCP resource is `https://mcp.nav.rainforest.org.cn/mcp` — the MCP endpoint URL, not the bare origin. Rotating the plugin access key permanently revokes previously issued grants: a `refresh_token` exchange is refused unless the extension currently holds a bridge connection, and rotation moves the extension to a different isolated route.

Claude Desktop's CIMD / DCR behaviour is pending verification against the real client.

The bundled `rainforest-icon-generator` skill can generate a RainForest-standard SVG and apply it with `extension_generate_navigation_icon`. ChatGPT web can discover the same workflow directly from MCP through the `rainforest://skills/icon-generator` resource, the `rainforest_generate_navigation_icon` prompt, and `extension_get_icon_generation_guide`.

Icon acquisition is built in: `inspect_website_icon_assets` discovers first-party candidates, `fetch_public_resource_text` reads SVG/XML/manifest source even when served as `image/svg+xml`, and `extension_extract_rendered_page_assets` handles logos created in the browser's rendered DOM. New sites should use `extension_add_navigation_entry_with_icon`, which commits the entry and validated SVG together. Generated-icon writes require the current `skillDigest` returned by the guide tool so a client cannot silently skip the active specification.

The portable entry points are `plugin.json` and `mcp.json`. `.codex-plugin/plugin.json` and `.mcp.json` remain as compatibility files for local Codex installations.
