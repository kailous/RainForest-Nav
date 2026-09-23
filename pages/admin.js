import React, { useState, useEffect } from 'react';
import Head from 'next/head';

const AdminPage = () => {
  const [token, setToken] = useState(null);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [entries, setEntries] = useState([]);
  const [editingEntry, setEditingEntry] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [activeNav, setActiveNav] = useState('entries');
  const [form, setForm] = useState({ name: '', url: '', description: '', categories: '', iconUrl: '' });
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [pwdForm, setPwdForm] = useState({ current: '', newPwd: '', confirm: '' });
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState('');
  const [pwdSuccess, setPwdSuccess] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [categoryTags, setCategoryTags] = useState([]);
  const [svgMode, setSvgMode] = useState('upload');
  const [svgCode, setSvgCode] = useState('');

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const fetchEntries = async () => {
    const res = await fetch('/api/getDatabaseContent');
    const data = await res.json();
    setEntries(data.entries || []);
  };
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpState, setMcpState] = useState(null);
  const [mcpKeyPlaintext, setMcpKeyPlaintext] = useState('');
  const [mcpBusy, setMcpBusy] = useState(false);

  useEffect(() => {
    const saved = sessionStorage.getItem('admin_token');
    if (saved) setToken(saved);
  }, []);

  useEffect(() => {
    if (token) fetchEntries();
  }, [token]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setMcpUrl(`${window.location.origin}/api/mcp`);
    setLoginError('');
    const res = await fetch('/api/_auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  // The MCP panel is fetched on demand: it needs the admin token and is only
  // shown on its own tab.
  useEffect(() => {
    if (token && activeNav === 'mcp') loadMcpState();
  }, [token, activeNav]);

    if (res.ok) {
      const data = await res.json();
      setToken(data.token);
      sessionStorage.setItem('admin_token', data.token);
    } else {
      setLoginError('密码错误');
    }
  };

  const handleUploadIcon = async (e, pastedContent, pastedFilename) => {
    let text, filename;
    if (pastedContent) {
      text = pastedContent;
      filename = pastedFilename || 'pasted-icon.svg';
    } else {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.svg')) {
        setMessage('只支持 SVG 文件');
        return;
      }
      text = await file.text();
      filename = file.name;
    }
    setUploading(true);
    try {
      const res = await fetch('/api/uploadIcon', {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename, content: text }),
      });
      if (res.ok) {
        const data = await res.json();
        setForm({ ...form, iconUrl: data.url });
        setMessage('图标上传成功');
      } else {
        setMessage('上传失败');
      }
    } catch (err) {
      setMessage('上传出错');
    }
    setUploading(false);
    if (e && e.target) e.target.value = '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    const payload = { ...form, categories: categoryTags };
    try {
      if (editingEntry) {
        const res = await fetch('/api/manageData', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ uuid: editingEntry.uuid, ...payload }),
        });
        if (res.ok) {
          setMessage('更新成功');
          setShowModal(false);
        }
      } else {
        const res = await fetch('/api/manageData', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          setMessage('添加成功');
          setShowModal(false);
        }
      }
      setForm({ name: '', url: '', description: '', categories: '', iconUrl: '' });
      setEditingEntry(null);
      fetchEntries();
    } catch (err) {
      setMessage('操作失败');
    }
    setSaving(false);
  };

  const handleEdit = (entry) => {
    setEditingEntry(entry);
    setForm({
      name: entry.name,
      url: entry.url,
      description: entry.description || '',
      categories: (entry.categories || []).join(', '),
      iconUrl: entry.iconUrl || '',
    });
    setCategoryTags(entry.categories || []);
    setTagInput('');
    setSvgMode('upload');
    setSvgCode('');
    setShowModal(true);
  };

  const handleDelete = async (uuid) => {
    if (!confirm('确定删除这条记录？')) return;
    const res = await fetch('/api/manageData', {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ uuid }),
    });
    if (res.ok) {
      setMessage('删除成功');
      fetchEntries();
    }
  };

  const handleCancel = () => {
    setEditingEntry(null);
    setForm({ name: '', url: '', description: '', categories: '', iconUrl: '' });
    setCategoryTags([]);
    setTagInput('');
    setSvgMode('upload');
    setSvgCode('');
    setShowModal(false);
  };

  const handleAddNew = () => {
    setEditingEntry(null);
    setForm({ name: '', url: '', description: '', categories: '', iconUrl: '' });
    setCategoryTags([]);
    setTagInput('');
    setSvgMode('upload');
    setSvgCode('');
    setShowModal(true);
  };

  const handleAddTag = (value) => {
    const tag = value.trim();
    if (tag && !categoryTags.includes(tag)) {
      setCategoryTags([...categoryTags, tag]);
    }
    setTagInput('');
  };

  const handleRemoveTag = (index) => {
    setCategoryTags(categoryTags.filter((_, i) => i !== index));
  };

  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      handleAddTag(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && categoryTags.length > 0) {
      setCategoryTags(categoryTags.slice(0, -1));
    }
  };

  const handlePasteSvg = () => {
    if (!svgCode.trim()) {
      setMessage('请粘贴 SVG 代码');
      return;
    }
    handleUploadIcon(null, svgCode.trim(), 'pasted-icon.svg');
  };

  const handleLogout = () => {
    setToken(null);
    sessionStorage.removeItem('admin_token');
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwdError('');
    setPwdSuccess('');
    if (pwdForm.newPwd !== pwdForm.confirm) {
      setPwdError('两次输入的新密码不一致');
      return;
    }
  const copyMcpText = async (value, successMessage) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setMessage(successMessage);
    } catch {
      setMessage('复制失败，请手动复制');
    }
  };

  const mcpRequest = async (method, body) => {
    const response = await fetch('/api/mcp/settings', {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      setMessage(detail.error || '操作失败');
      return null;
    }
    return response.json();
  };

  const loadMcpState = async () => {
    const state = await mcpRequest('GET');
    if (state) setMcpState(state);
  };

  const runMcpAction = async action => {
    setMcpBusy(true);
    const result = await mcpRequest('POST', action);
    if (result) {
      // The plaintext key is only ever present on the response that creates it.
      setMcpKeyPlaintext(result.key || '');
      setMcpState(result);
    }
    setMcpBusy(false);
  };

  const copyLocalMcpConfig = () => {
    copyMcpText(
      JSON.stringify(
        {
          mcpServers: {
            'rainforest-online': {
              type: 'http',
              url: mcpUrl,
              headers: { Authorization: 'Bearer <线上 MCP 密钥>' },
            },
          },
        },
        null,
        2,
      ),
      '本地客户端配置已复制',
    );
  };

  const formatMcpTime = value =>
    value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';

    if (pwdForm.newPwd.length < 6) {
      setPwdError('新密码至少 6 位');
      return;
    }
    setPwdSaving(true);
    try {
      const res = await fetch('/api/_auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwdForm.current }),
      });
      if (!res.ok) {
        setPwdError('当前密码错误');
        setPwdSaving(false);
        return;
      }
      const updateRes = await fetch('/api/changePassword', {
        method: 'POST',
        headers,
        body: JSON.stringify({ currentPassword: pwdForm.current, newPassword: pwdForm.newPwd }),
      });
      if (updateRes.ok) {
        setPwdSuccess('密码修改成功，请使用新密码重新登录');
        setPwdForm({ current: '', newPwd: '', confirm: '' });
        setTimeout(() => {
          handleLogout();
        }, 2000);
      } else {
        const data = await updateRes.json();
        setPwdError(data.error || '修改失败');
      }
    } catch (err) {
      setPwdError('网络错误');
    }
    setPwdSaving(false);
  };

  const filteredEntries = entries.filter(entry =>
    entry.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (entry.description || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (entry.categories || []).some(c => c.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const uniqueTags = [...new Set(entries.flatMap(e => e.categories || []))];

  if (!token) {
    return (
      <>
        <Head><title>管理登录 - RainForest Nav</title></Head>
        <div className="saas-login">
          <div className="saas-login-card">
            <img src="/logo.webp" alt="RainForest" className="saas-login-logo-img" />
            <h2>RainForest Nav</h2>
            <p className="saas-login-subtitle">导航管理后台</p>
            <form onSubmit={handleLogin}>
              <div className="saas-input-group">
                <label>管理密码</label>
                <input
                  type="password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
              </div>
              {loginError && <p className="saas-error">{loginError}</p>}
              <button type="submit" className="saas-btn-primary saas-btn-full">登录</button>
            </form>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Head><title>导航管理 - RainForest Nav</title></Head>
      <div className="saas-layout">
        <aside className="saas-sidebar">
          <div className="saas-sidebar-header">
            <img src="/logo.webp" alt="RainForest" className="saas-sidebar-logo-img" />
            <span className="saas-sidebar-title">RainForest<br />Nav</span>
          </div>
          <nav className="saas-nav">
            <div className="saas-nav-section-label">菜单</div>
            <a
              className={`saas-nav-item${activeNav === 'entries' ? ' active' : ''}`}
              onClick={() => setActiveNav('entries')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              导航管理
            </a>
            <a
              className={`saas-nav-item${activeNav === 'settings' ? ' active' : ''}`}
              onClick={() => setActiveNav('settings')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              修改密码
            </a>
          </nav>
            <a
              className={`saas-nav-item${activeNav === 'mcp' ? ' active' : ''}`}
              onClick={() => setActiveNav('mcp')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 9l-3 3 3 3"/><path d="M16 9l3 3-3 3"/><path d="M14 5l-4 14"/></svg>
              MCP 接入
            </a>
          <div className="saas-sidebar-stats">
            <div className="saas-sidebar-stat">
              <span className="saas-sidebar-stat-value">{entries.length}</span>
              <span className="saas-sidebar-stat-label">条目</span>
            </div>
            <div className="saas-sidebar-stat">
              <span className="saas-sidebar-stat-value">{uniqueTags.length}</span>
              <span className="saas-sidebar-stat-label">分类</span>
            </div>
            <div className="saas-sidebar-stat">
              <span className="saas-sidebar-stat-value">{entries.filter(e => e.iconUrl).length}</span>
              <span className="saas-sidebar-stat-label">图标</span>
            </div>
          </div>
          <div className="saas-sidebar-footer">
            <button className="saas-logout-btn" onClick={handleLogout}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              退出登录
            </button>
          </div>
        </aside>

        <main className="saas-main">
          {message && (
            <div className="saas-toast">
              {message}
              <button onClick={() => setMessage('')}>&times;</button>
            </div>
          )}

          {activeNav === 'entries' && (
            <>
              <div className="saas-page-header">
                <div>
                  <h2 className="saas-page-title">导航管理</h2>
                  <p className="saas-page-subtitle">管理所有导航条目和分类</p>
                </div>
                <div className="saas-page-actions">
                  <div className="saas-search">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input
                      type="text"
                      placeholder="搜索..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <button className="saas-btn-primary" onClick={handleAddNew}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    添加条目
                  </button>
                </div>
              </div>
              <div className="saas-table-wrapper">
                <table className="saas-table">
                  <thead>
                    <tr>
                      <th style={{ width: 52 }}></th>
                      <th>名称</th>
                      <th>链接</th>
                      <th>分类</th>
                      <th>描述</th>
                      <th style={{ width: 100 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.map((entry) => (
                      <tr key={entry.uuid}>
                        <td>
                          <div className="saas-table-icon">
                            {entry.iconUrl ? <img src={entry.iconUrl} alt="" /> : <span>—</span>}
                          </div>
                        </td>
                        <td><strong>{entry.name}</strong></td>
                        <td><a href={entry.url} target="_blank" rel="noopener noreferrer" className="saas-link">{entry.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a></td>
                        <td>
                          <div className="saas-table-tags">
                            {(entry.categories || []).map((tag, i) => (
                              <span className="saas-tag" key={i}>{tag}</span>
                            ))}
                          </div>
                        </td>
                        <td className="saas-table-desc">{entry.description || '—'}</td>
                        <td>
                          <div className="saas-table-actions">
                            <button className="saas-action-btn" onClick={() => handleEdit(entry)} title="编辑">
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                            <button className="saas-action-btn saas-action-danger" onClick={() => handleDelete(entry.uuid)} title="删除">
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredEntries.length === 0 && (
                      <tr><td colSpan="6" className="saas-empty">暂无数据</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {activeNav === 'settings' && (
            <div className="saas-settings">
              <div className="saas-page-header">
                <div>
                  <h2 className="saas-page-title">修改密码</h2>
                  <p className="saas-page-subtitle">更新管理后台的登录密码</p>
                </div>
              </div>
          {activeNav === 'mcp' && (
            <div className="saas-settings saas-mcp-page">
              <div className="saas-page-header saas-page-header-inset">
                <div>
                  <h2 className="saas-page-title">MCP 接入</h2>
                  <p className="saas-page-subtitle">让 ChatGPT、Codex 或 Claude 查询和管理在线导航</p>
                </div>
              </div>

              <div className="mcp-card">
                <div className="mcp-status-row">
                  <span
                    className="mcp-status-dot"
                    style={{ background: mcpState?.enabled ? 'var(--success-color)' : 'var(--text-color-light)' }}
                  ></span>
                  <span>{mcpState?.enabled ? '已开启' : '已关闭'}</span>
                  <button
                    type="button"
                    className="saas-btn-ghost"
                    onClick={() => runMcpAction({ action: 'set-enabled', enabled: !mcpState?.enabled })}
                    disabled={mcpBusy || !mcpState?.hasKey}
                  >
                    {mcpState?.enabled ? '关闭接入' : '开启接入'}
                  </button>
                </div>
                <p className="saas-settings-desc">
                  开启后，持有下方密钥或已完成 OAuth 授权的 AI 客户端可以查询、添加、修改和删除在线导航。
                  关闭会立即撤销全部已授权的访问令牌。此开关与浏览器插件的 MCP 接入互不影响。
                </p>

                <h3 className="mcp-config-title">线上 MCP 密钥</h3>
                {!mcpState?.hasKey ? (
                  <>
                    <p className="saas-settings-desc">
                      还没有密钥。生成后请立即复制保存——服务端只保存哈希，之后无法再次查看完整密钥。
                    </p>
                    <button
                      type="button"
                      className="saas-btn-primary"
                      onClick={() => runMcpAction({ action: 'generate-key' })}
                      disabled={mcpBusy}
                    >
                      生成密钥
                    </button>
                  </>
                ) : (
                  <>
                    <div className="mcp-copy-row">
                      <code>{mcpKeyPlaintext || `rfn_live_••••••••••••${mcpState.keyLast4}`}</code>
                      <button
                        type="button"
                        className="saas-btn-ghost"
                        onClick={() => copyMcpText(mcpKeyPlaintext, '密钥已复制')}
                        disabled={!mcpKeyPlaintext}
                      >
                        复制密钥
                      </button>
                      <button
                        type="button"
                        className="saas-btn-ghost"
                        onClick={() => runMcpAction({ action: 'rotate-key' })}
                        disabled={mcpBusy}
                      >
                        重新生成
                      </button>
                    </div>
                    <p className="saas-settings-desc">
                      {mcpKeyPlaintext
                        ? '完整密钥只在本次显示，刷新页面后只能看到末四位。'
                        : '完整密钥无法再次查看。如果遗失，请重新生成。'}
                      {' '}创建于 {formatMcpTime(mcpState.keyCreatedAt)} · 密钥版本 {mcpState.credentialVersion}
                    </p>
                  </>
                )}

                <h3 className="mcp-config-title">在 ChatGPT 中添加</h3>
                <ol className="saas-settings-desc" style={{ paddingLeft: 20, lineHeight: 1.9 }}>
                  <li>在 ChatGPT「设置 → 安全与登录」开启开发者模式。</li>
                  <li>打开 ChatGPT 插件页，点击 ＋，名称填写 RainForest Navigator，连接地址填写下方地址。</li>
                  <li>在授权页粘贴上面的线上 MCP 密钥完成授权。</li>
                </ol>
                <div className="mcp-copy-row">
                  <code>{mcpUrl || '/api/mcp'}</code>
                  <button
                    type="button"
                    className="saas-btn-primary"
                    onClick={() => copyMcpText(mcpUrl, 'MCP 地址已复制')}
                    disabled={!mcpUrl}
                  >
                    复制地址
                  </button>
                </div>

                <h3 className="mcp-config-title">本地客户端</h3>
                <p className="saas-settings-desc">适用于 Codex、Claude Desktop 或命令行脚本，使用同一个线上 MCP 密钥。</p>
                <div className="mcp-config-block">
                  <pre>{JSON.stringify({
                    mcpServers: {
                      'rainforest-online': {
                        type: 'http',
                        url: mcpUrl || '/api/mcp',
                        headers: { Authorization: 'Bearer <线上 MCP 密钥>' },
                      },
                    },
                  }, null, 2)}</pre>
                  <button type="button" className="saas-btn-ghost" onClick={copyLocalMcpConfig} disabled={!mcpUrl}>
                    复制配置
                  </button>
                </div>

                <h3 className="mcp-config-title">状态</h3>
                <ul className="saas-settings-desc" style={{ listStyle: 'none', padding: 0, lineHeight: 2 }}>
                  <li>最近一次 MCP 调用：{formatMcpTime(mcpState?.lastRequestAt)}</li>
                  <li>最近一次授权：{formatMcpTime(mcpState?.lastAuthorizeAt)}</li>
                </ul>

                <div className="mcp-auth-note">
                  <strong>权限与隔离</strong>
                  <p>
                    持有线上 MCP 密钥等同于完整读写权限。OAuth 令牌则严格按授权时授予的范围生效。
                    线上 MCP 密钥、浏览器插件的访问密钥、后台登录密码三者完全独立，分别轮换互不影响。
                  </p>
                </div>
              </div>
            </div>
          )}


              <div className="pwd-card-wrapper">
                <div className="pwd-card">
                  <div className="pwd-card-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  </div>
                  <h3 className="pwd-card-title">更改密码</h3>
                  <p className="pwd-card-desc">请确保新密码至少包含 6 个字符</p>
                  
                  <form onSubmit={handleChangePassword}>
                    <div className="pwd-field">
                      <label>当前密码</label>
                      <div className="pwd-input-wrap">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        <input
                          type="password"
                          value={pwdForm.current}
                          onChange={(e) => setPwdForm({ ...pwdForm, current: e.target.value })}
                          placeholder="输入当前密码"
                          required
                        />
                      </div>
                    </div>
                    
                    <div className="pwd-field">
                      <label>新密码</label>
                      <div className="pwd-input-wrap">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        <input
                          type="password"
                          value={pwdForm.newPwd}
                          onChange={(e) => setPwdForm({ ...pwdForm, newPwd: e.target.value })}
                          placeholder="输入新密码"
                          required
                        />
                      </div>
                    </div>
                    
                    <div className="pwd-field">
                      <label>确认新密码</label>
                      <div className="pwd-input-wrap">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        <input
                          type="password"
                          value={pwdForm.confirm}
                          onChange={(e) => setPwdForm({ ...pwdForm, confirm: e.target.value })}
                          placeholder="再次输入新密码"
                          required
                        />
                      </div>
                    </div>
                    
                    {pwdError && <div className="pwd-message pwd-message-error">{pwdError}</div>}
                    {pwdSuccess && <div className="pwd-message pwd-message-success">{pwdSuccess}</div>}
                    
                    <button type="submit" className="saas-btn-primary saas-btn-full" disabled={pwdSaving}>
                      {pwdSaving ? (
                        <>
                          <svg className="pwd-spinner" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"/></svg>
                          修改中...
                        </>
                      ) : '确认修改'}
                    </button>
                  </form>
                </div>
                
                <div className="pwd-tip-card">
                  <div className="pwd-tip-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  </div>
                  <div className="pwd-tip-content">
                    <h4>安全提示</h4>
                    <p>修改密码后需要重新登录。建议使用包含字母、数字和特殊字符的强密码。</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {showModal && (
        <div className="saas-modal-overlay" onClick={handleCancel}>
          <div className="saas-modal" onClick={(e) => e.stopPropagation()}>
            <div className="saas-modal-header">
              <div className="saas-modal-title-row">
                <div className="saas-modal-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </div>
                <div>
                  <h3>{editingEntry ? '编辑条目' : '添加条目'}</h3>
                  <p className="saas-modal-subtitle">{editingEntry ? '修改导航条目的详细信息' : '填写新导航条目的信息'}</p>
                </div>
              </div>
              <button className="saas-modal-close" onClick={handleCancel}>&times;</button>
            </div>
            <div className="saas-modal-divider"></div>
            <form onSubmit={handleSubmit}>
              <div className="saas-modal-body">
                <div className="saas-form-row">
                  <div className="saas-field">
                    <label>名称 <span className="saas-required">*</span></label>
                    <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="站点名称" required />
                  </div>
                  <div className="saas-field">
                    <label>链接 <span className="saas-required">*</span></label>
                    <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com" required />
                  </div>
                </div>
                <div className="saas-field">
                  <label>描述</label>
                  <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="简短描述（可选）" />
                </div>
                <div className="saas-field">
                  <label>分类</label>
                  <div className="saas-tag-input" onClick={() => { const el = document.querySelector('.saas-tag-input input'); if (el) el.focus(); }}>
                    {categoryTags.map((tag, i) => (
                      <span className="saas-tag-chip" key={i}>
                        {tag}
                        <button type="button" className="saas-tag-remove" onClick={(e) => { e.stopPropagation(); handleRemoveTag(i); }}>&times;</button>
                      </span>
                    ))}
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={handleTagKeyDown}
                      onBlur={() => { if (tagInput.trim()) handleAddTag(tagInput); }}
                      placeholder={categoryTags.length === 0 ? '输入后按回车添加' : ''}
                    />
                  </div>
                </div>
                <div className="saas-field">
                  <label>图标</label>
                  <div className="saas-svg-tabs">
                    <button type="button" className={`saas-svg-tab${svgMode === 'upload' ? ' active' : ''}`} onClick={() => setSvgMode('upload')}>上传文件</button>
                    <button type="button" className={`saas-svg-tab${svgMode === 'paste' ? ' active' : ''}`} onClick={() => setSvgMode('paste')}>粘贴代码</button>
                  </div>
                  {form.iconUrl && (
                    <div className="saas-icon-preview-row">
                      <img src={form.iconUrl} alt="preview" className="saas-icon-preview" />
                      <span className="saas-icon-preview-label">已上传</span>
                    </div>
                  )}
                  {svgMode === 'upload' ? (
                    <label className="saas-upload-area">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      <span>{uploading ? '上传中...' : '点击选择 SVG 文件'}</span>
                      <input type="file" accept=".svg" onChange={(e) => handleUploadIcon(e)} disabled={uploading} />
                    </label>
                  ) : (
                    <div className="saas-svg-paste">
                      <textarea
                        value={svgCode}
                        onChange={(e) => setSvgCode(e.target.value)}
                        placeholder={'粘贴 SVG 代码到这里...'}
                        rows={5}
                      />
                      <button type="button" className="saas-btn-primary saas-btn-sm" onClick={handlePasteSvg} disabled={uploading}>
                        {uploading ? '上传中...' : '上传 SVG'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="saas-modal-footer">
                <button type="button" className="saas-btn-ghost" onClick={handleCancel}>取消</button>
                <button type="submit" className="saas-btn-primary" disabled={saving}>
                  {saving ? '保存中...' : (editingEntry ? '保存修改' : '添加条目')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

export default AdminPage;
