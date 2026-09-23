## RainForest Nav

一个基于 Next.js + Vercel Blob 的导航网站项目，无需数据库，通过管理后台即可管理所有导航条目。

在线地址：[nav.rainforest.org.cn](https://nav.rainforest.org.cn)

## 特性

- 数据存储于 Vercel Blob，零成本、无需数据库
- 内置管理后台（`/admin`），支持增删改查、图标上传
- 支持自定义 SVG 图标
- 提供 Streamable HTTP MCP（`/api/mcp`），AI 可查询和管理导航条目
- 附带 Codex 插件包，可同时操作在线数据与 Chrome 扩展本地数据
- 响应式设计
- 部署在 Vercel 上，开箱即用

## 环境变量

- `ADMIN_PASSWORD`: 管理后台密码。**仅用于后台登录，不是 MCP 凭据**
- `BLOB_READ_WRITE_TOKEN`: Vercel Blob 的读写 Token（部署到 Vercel 后自动生成），保存在线导航数据
- `ONLINE_SITE_ORIGIN`: 本站的 canonical origin，例如 `https://nav.rainforest.org.cn`。**生产环境必填**，OAuth 的 issuer 与 resource 都由它派生；缺失时相关端点 fail closed，绝不会退回按 Host 头推导
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis 的 REST 端点与令牌。承担线上 MCP 的认证控制面（`enabled`、`credentialVersion`、密钥哈希）与 OAuth 一次性状态
- `MCP_OAUTH_SIGNING_KEY`: OAuth 自包含凭据的 HMAC 签名密钥，至少 32 字符，必须配置为服务端专用的敏感变量。它与线上 MCP 密钥是完全不同的生命周期，轮换密钥不会影响它
- `MCP_OAUTH_SIGNING_KEY_PREVIOUS`: 可选的上一版签名密钥，**仅用于验证**迁移窗口内的旧凭据，不得用于签发，迁移结束后应删除
- `MCP_OAUTH_SIGNING_KEY_VERSION`: 当前签名密钥的版本号，默认 `1`
- `MCP_CIMD_ALLOWED_ORIGINS`: 允许的 CIMD 客户端元数据来源，逗号分隔，例如 `https://chatgpt.com`。未配置时 URL 型客户端注册会被拒绝（仅保留 DCR 兜底）
- `NAV_NAME`: 导航名称，显示在网页标题中
- `EDGE_CONFIG`: Vercel Edge Config 配置
- `OG_DESC`: Open Graph 描述
- `OG_KEYWORDS`: Open Graph 关键词
- `OG_IMG`: Open Graph 图片 URL
- `OG_LOGO`: Open Graph Logo URL
- `OG_URL`: Open Graph URL

部署前运行 `npm run check:production-config` 校验以上配置。

## MCP

项目提供两套**完全独立**的 MCP 服务，数据、权限与启停互不影响：

| | 线上版 | 插件版 |
|---|---|---|
| 地址 | `https://<your-domain>/api/mcp` | `https://mcp.nav.rainforest.org.cn/mcp` |
| 实现 | Next.js on Vercel | Cloudflare Worker（`mcp/`） |
| 数据 | Vercel Blob | 浏览器插件 IndexedDB |
| 凭据 | **线上 MCP 密钥** | **插件访问密钥** |

### 三类凭据彼此隔离

| 凭据 | 归属 | 用途 | 轮换影响 |
|---|---|---|---|
| 线上 MCP 密钥（`rfn_live_*`） | 导航站点 | 只驱动线上版 MCP | 不影响插件与后台登录 |
| 插件访问密钥 | 浏览器插件 | 只驱动插件版 MCP | 不影响线上版与后台登录 |
| 后台登录密码 | 导航站点 | 只用于登录 `/admin` | 与 MCP 鉴权无关 |

三者互不通用。线上版不接受插件密钥，插件版也不接受线上密钥；管理密码不能作为任何 MCP 的 Bearer Token。

### 线上版接入方式

**ChatGPT 网页端**：后台「MCP 接入」页开启接入并生成线上 MCP 密钥，然后在 ChatGPT 开发者模式中添加 `https://<your-domain>/api/mcp`，授权页粘贴该密钥。授权采用 OAuth 2.1 + PKCE（S256），客户端注册优先使用 CIMD，DCR 作为兼容兜底。**Claude Desktop 的 CIMD / DCR 行为待实机验证。**

**本地客户端**（Codex、Claude Desktop、命令行）：

```text
Authorization: Bearer rfn_live_...
```

`/api/mcp` 整体是受保护资源：`initialize`、`tools/list`、`tools/call`、`resources/*`、`prompts/*`、`skills/*` 全部需要有效凭据。无凭据或凭据无效返回 401 并附 `WWW-Authenticate`；凭据有效但 scope 不足返回 403 `insufficient_scope`；接入被管理员关闭时返回 503 `service_disabled` 且不带 `WWW-Authenticate`，避免客户端陷入重复授权。

线上 MCP 密钥等同完整读写权限；OAuth 令牌严格按授权时授予的 scope 生效。

### 插件版

插件后台有独立的「MCP接入」菜单与开关：开启后插件主动连接云端中继，数据仍只保存在浏览器 IndexedDB。图标规范位于 `Skill/rainforest-icon-generator/`，两套 MCP 都会通过 `get_icon_generation_guide`、资源与提示词提供。`plugins/rainforest-navigator/` 是可分发到 ChatGPT 与 Codex 的 portable plugin 包。

### 上线前必须执行

```bash
npm run check:production-config          # 校验生产环境变量
npm run test:upstash-integration         # 用真实 Redis 验证 Lua 原子轮换
```

`test:upstash-integration` 在缺少真实 Upstash 凭据时会明确 SKIP；**部署前必须实际执行并通过**。

## 部署

### Vercel

1. Fork 本项目
2. 在 Vercel 中导入 Fork 的项目
3. 配置环境变量（至少需要 `ADMIN_PASSWORD` 和 `BLOB_READ_WRITE_TOKEN`）
4. 部署

```bash
npm run dev
```

在浏览器中打开 [http://localhost:3000](http://localhost:3000) 查看。

访问 [http://localhost:3000/admin](http://localhost:3000/admin) 管理导航条目。
