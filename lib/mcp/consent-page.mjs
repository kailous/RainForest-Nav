// Server-rendered consent and error pages for the online authorization server.
// Self-contained by design: no stylesheet imports, so the page renders correctly
// regardless of how the serverless bundle arranges its files.
// Runtime-independent: plain string building.

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const THEME = `
:root{--bg:hsla(0,0%,95%,1);--card:hsla(0,0%,100%,1);--fg:hsla(0,0%,20%,1);--muted:hsla(0,0%,45%,1);--line:hsla(0,0%,78%,1);--accent:hsla(29,100%,45%,1)}
@media(prefers-color-scheme:dark){:root{--bg:hsla(0,0%,20%,1);--card:hsla(0,0%,13%,1);--fg:hsla(0,0%,100%,1);--muted:hsla(0,0%,72%,1);--line:hsla(0,0%,40%,1);--accent:hsla(29,100%,50%,1)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 Urbanist,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;display:flex;justify-content:center;padding:48px 20px}
main{width:100%;max-width:520px}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:28px;font-weight:600}
.mark{width:40px;height:40px;display:grid;place-items:center;background:var(--accent);border-radius:20px;color:#fff;font-weight:800}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:32px}
h1{font-size:22px;margin:0 0 10px}
p{color:var(--muted);margin:0 0 18px}
.client{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 22px}
.client strong{display:block;overflow-wrap:anywhere}
.client small{color:var(--muted)}
h2{font-size:14px;margin:0 0 10px}
ul{list-style:none;padding:0;margin:0 0 24px}
li{padding:5px 0;color:var(--muted)}
li::before{content:'✓';margin-right:10px;color:var(--accent)}
label{display:block;font-size:14px;font-weight:600;margin-bottom:8px}
input{width:100%;padding:13px 14px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;min-height:48px}
.hint{font-size:13px;margin:10px 0 22px}
button{border:0;background:var(--accent);color:#fff;border-radius:9px;padding:13px 20px;font:600 16px inherit;width:100%;cursor:pointer}
.error{border:1px solid var(--accent);color:var(--fg);border-radius:9px;padding:12px 14px;margin:0 0 20px;font-size:14px}
.note{border-top:1px solid var(--line);margin-top:24px;padding-top:18px;font-size:13px;color:var(--muted)}
`;

function document(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · RainForest</title><style>${THEME}</style></head><body><main><div class="brand"><span class="mark">RF</span>RainForest Nav</div><div class="card">${body}</div></main></body></html>`;
}

const SCOPE_LABELS = {
  'navigation:read': '查询导航条目、分类与图标',
  'navigation:write': '添加、修改、删除导航与图标',
};

export function renderConsentPage({ ticket, csrfToken, clientName, clientOrigin, scopes, errorMessage = '' }) {
  const scopeItems = scopes
    .map(scope => `<li>${escapeHtml(SCOPE_LABELS[scope] || scope)}</li>`)
    .join('');

  return document('连接授权', `
<p style="font-size:13px;margin:0 0 8px">安全连接</p>
<h1>连接你的导航</h1>
<p>授权后，AI 可以通过 RainForest 访问你在线上保存的导航。</p>
<div class="client"><strong>${escapeHtml(clientName)}</strong><small>${escapeHtml(clientOrigin)}</small></div>
<h2>此连接将获得以下权限</h2>
<ul>${scopeItems}</ul>
${errorMessage ? `<div class="error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
<label for="mcp_key">线上 MCP 密钥</label>
<input id="mcp_key" name="mcp_key" type="password" required autocomplete="off" spellcheck="false" placeholder="粘贴从后台复制的 rfn_live_ 密钥">
<p class="hint">打开导航后台 → MCP 接入，复制密钥后粘贴到这里。</p>
<button type="submit">授权并连接</button>
</form>
<p class="note">密钥只用于本次授权校验，不会写入跳转地址或日志。关闭 MCP 接入或重新生成密钥可立即撤销访问。</p>`);
}

export function renderAuthorizationErrorPage(title, message, note = '请返回你的 AI 客户端重新发起连接。') {
  return document(title, `
<p style="font-size:13px;margin:0 0 8px">连接需要重试</p>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="note">${escapeHtml(note)}</p>`);
}

export function renderMcpDisabledPage() {
  return document('MCP 接入已关闭', `
<p style="font-size:13px;margin:0 0 8px">服务未开放</p>
<h1>MCP 接入已关闭</h1>
<p>这台 RainForest 导航当前没有开放 MCP 访问，因此无法完成授权。</p>
<p class="note">请先在导航后台的「MCP 接入」页面生成密钥并开启访问，然后返回 AI 客户端重新连接。</p>`);
}
