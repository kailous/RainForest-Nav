import frontendVariables from './frontend-theme.css';

export function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

const styles = `
@font-face{font-family:Urbanist;src:url('/assets/Urbanist.ttf') format('truetype');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}body{margin:0;background:var(--background-color);color:var(--text-main-color);font-family:Urbanist,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}a{color:var(--highlight-color)}
:is(button,a,input):focus-visible{outline:2px solid var(--highlight-color);outline-offset:4px}
.auth-shell{width:min(100% - 40px,520px);margin:64px auto 40px}
.auth-brand{display:flex;align-items:center;gap:12px;margin-bottom:32px;font-size:var(--font-size-title);font-weight:var(--font-weight-semibold)}
.auth-mark{width:40px;height:40px;display:grid;place-items:center;background:var(--highlight-color);border-radius:20px;color:var(--text-main-color);font-weight:var(--font-weight-extrabold)}
.auth-card{border:1px solid var(--text-color-light);border-radius:20px;background:var(--cord-color);padding:32px;box-shadow:0 1px 3px var(--shadow-color)}
.auth-eyebrow{color:var(--highlight-color);font-size:var(--font-size-xs);margin:0 0 10px;letter-spacing:.04em}
h1{font-size:var(--font-size-xxl);line-height:1.3;margin:0 0 12px;font-weight:var(--font-weight-semibold);letter-spacing:-.03em}
p{color:var(--text-color);line-height:1.75;margin:0 0 20px;font-size:var(--font-size-base)}
.auth-client{padding:16px;background:var(--background-color);border:1px solid var(--text-color-light);border-radius:10px;margin:24px 0}
.auth-client strong{display:block;overflow-wrap:anywhere}.auth-client small{color:var(--text-color);display:block;margin-top:4px}
h2,label{font-size:var(--font-size-sm);font-weight:var(--font-weight-semibold);margin:0 0 10px;display:block}
ul{padding:0;margin:0 0 28px;list-style:none}li{padding:7px 0;color:var(--text-color);font-size:var(--font-size-base)}li:before{content:'✓';color:var(--success-color);margin-right:10px}
input{width:100%;padding:13px 14px;border-radius:9px;border:1px solid var(--text-color-light);background:var(--background-color);color:var(--text-main-color);font:inherit;min-height:48px}
.auth-hint{font-size:var(--font-size-xs);margin:10px 0 22px}.auth-actions{display:flex;gap:16px;align-items:center}
button,.auth-return{border:0;background:var(--highlight-color);color:var(--text-main-color);border-radius:9px;padding:13px 20px;font:var(--font-weight-semibold) var(--font-size-base) Urbanist,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;cursor:pointer;text-decoration:none;text-align:center}
button{flex:1}button:hover,.auth-return:hover{filter:brightness(1.06)}.auth-cancel{font-size:var(--font-size-sm);color:var(--text-color);padding:12px 0}
.auth-error{border:1px solid var(--highlight-color);background:var(--cord-color);color:var(--text-main-color);padding:12px 14px;border-radius:9px;margin:20px 0;font-size:var(--font-size-sm);line-height:1.6}
.auth-footer{border-top:1px solid var(--text-color-light);padding-top:20px;margin:24px 0 0;font-size:var(--font-size-xs)}
.auth-note{text-align:center;font-size:var(--font-size-xs);margin:20px 0}.auth-return{display:block}
@media(max-width:540px){.auth-shell{margin-top:28px}.auth-card{padding:24px}.auth-brand{margin-bottom:24px}h1{font-size:var(--font-size-xl)}}
`;

function document(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · RainForest</title><style>${frontendVariables}\n${styles}</style></head><body data-rainforest-ui="auth"><main class="auth-shell"><div class="auth-brand"><div class="auth-mark" aria-hidden="true">RF</div>RainForest Navigator</div><section class="auth-card">${body}</section><p class="auth-note">RainForest MCP接入 · 由你掌控访问权限</p></main></body></html>`;
}

export function consentPage(ticket, csrfToken, requestInfo, client, errorMessage = '') {
  const scopes = requestInfo.scopes.map(scope => scope === 'navigation:read' ? '查询导航条目、分类与图标' : '添加、修改、删除导航和图标');
  return document('连接授权', `<p class="auth-eyebrow">安全连接</p><h1>连接你的导航</h1><p>授权后，AI 可以通过 RainForest 访问这个浏览器中的导航。</p><div class="auth-client"><strong>${escapeHtml(client.clientName)}</strong><small>${escapeHtml(new URL(requestInfo.redirectUri).origin)}</small></div><h2>此连接将获得以下权限</h2><ul>${scopes.map(scope => `<li>${escapeHtml(scope)}</li>`).join('')}</ul>${errorMessage ? `<div class="auth-error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}<form method="post" action="/oauth/authorize"><input type="hidden" name="ticket" value="${escapeHtml(ticket)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><label for="extension_token">插件访问密钥</label><input id="extension_token" name="extension_token" type="password" required minlength="43" maxlength="43" pattern="[A-Za-z0-9_\\-]{43}" autocomplete="off" spellcheck="false" aria-describedby="token-help" placeholder="粘贴从插件复制的密钥"><p class="auth-hint" id="token-help">打开插件后台 → MCP接入，开启访问后点击“复制密钥”。</p><div class="auth-actions"><button type="submit">授权并连接</button><a class="auth-cancel" href="https://chatgpt.com/plugins">暂不连接</a></div></form><p class="auth-footer">导航保存在浏览器本地；调用时，所需数据会经云端中继传给 AI 客户端。关闭 MCP接入可暂停访问，重新生成密钥可使旧连接无法访问本地导航。</p>`);
}

export function authorizationErrorPage(title, message) {
  return document(title, `<p class="auth-eyebrow">连接需要重试</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="auth-return" href="https://chatgpt.com/plugins">返回 ChatGPT 重新连接</a><p class="auth-footer">请保持安装 RainForest 的浏览器运行，并确认 MCP接入已开启。</p>`);
}
