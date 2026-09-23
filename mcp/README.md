# RainForest Extension MCP Worker

Cloud-hosted MCP and WebSocket relay for the browser-extension edition of RainForest Navigator.

This directory is independently deployable and is not packaged into the browser extension. The icon workflow is sourced from the repository-level `Skill/rainforest-icon-generator/` package.

- `POST /mcp` is the authenticated Streamable HTTP MCP endpoint.
- `GET /bridge` is the authenticated browser-extension WebSocket endpoint.
- `GET /status` reports whether a browser extension using the same access key is online.
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` expose OAuth discovery metadata.
- `/oauth/register`, `/oauth/authorize`, and `/oauth/token` implement dynamic client registration and OAuth 2.1 authorization-code + PKCE flows for ChatGPT web.
- Each access key is SHA-256 hashed and routed to its own Durable Object. The plaintext key is not stored.
- The worker never stores navigation entries. Commands are forwarded to the connected extension, which reads and writes its own IndexedDB.
- The icon-generation skill is exposed through MCP as a Markdown resource, a reusable prompt, a read-only guide tool, and a validated write tool.

## Icon generation skill

Authenticated MCP clients can discover the same RainForest icon workflow used by the packaged Codex skill:

- Resource: `rainforest://skills/icon-generator`
- Prompt: `rainforest_generate_navigation_icon`
- Guide tool: `extension_get_icon_generation_guide`
- Apply tool: `extension_generate_navigation_icon`
- Raw public resource tool: `fetch_public_resource_text`
- Official asset discovery: `inspect_website_icon_assets`
- Rendered DOM extraction: `extension_extract_rendered_page_assets`
- Add with validated icon: `extension_add_navigation_entry_with_icon`
- Generated icon writes require the current `skillDigest` returned by `extension_get_icon_generation_guide`

The apply tool requires a complete 64×64 SVG with the fixed RainForest base geometry. The browser extension rejects active SVG content, external asset references, invalid canvases, and modified base geometry before saving the icon to IndexedDB.

## Resource identifier

The OAuth resource ID is `https://mcp.nav.rainforest.org.cn/mcp` — the MCP
endpoint URL, not the bare origin. The bare origin is still accepted as a legacy
alias so connections created before this change keep working; remove
`LEGACY_RESOURCE_ID` from `src/index.js` once they have re-authorized.

## Refresh grants require a live extension

A `refresh_token` exchange is rejected with `invalid_grant` unless the paired
browser extension currently holds a bridge connection. Two reasons:

- MCP operations are relayed to the extension, so an offline extension could not
  serve any call anyway.
- Rotating the plugin access key routes the extension to a different Durable
  Object, so a grant issued under the previous key can never be refreshed —
  rotation therefore revokes access rather than merely moving it.

The check runs before the refresh token is consumed, so closing the browser
temporarily does not burn the token.

## Deploy

```bash
npm install
npm run deploy
```

After deployment, point `mcp.nav.rainforest.org.cn` (or another custom domain) at this Worker. The browser extension lets the user change the service address, so a `workers.dev` URL can also be used directly.

## Authentication

### ChatGPT web

Add `https://mcp.nav.rainforest.org.cn/mcp` in ChatGPT developer mode. ChatGPT discovers the OAuth endpoints, dynamically registers a public client, and opens the RainForest authorization page. The user pastes the extension access key once; the server verifies that the matching extension bridge is connected and issues short-lived OAuth access tokens plus rotating refresh tokens.

OAuth records are sharded by their hashed identifier across `OAuthRecord` Durable Objects. Authorization codes are one-time and expire after five minutes. Access tokens expire after one hour and refresh tokens after thirty days.

### Direct MCP clients

The extension generates a random access key locally. MCP clients send it as:

```text
Authorization: Bearer <access-key>
```

The extension uses the same key in the WebSocket subprotocol. Regenerating the key locally immediately moves the extension to a new isolated Durable Object and invalidates the previous route.
