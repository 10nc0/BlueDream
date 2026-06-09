'use strict';
(function () {
    // ──────────────────────────────────────────────────────────────────────────
    // AccountModule — self-contained account settings panel
    // Exposed as window.AccountModule = { init, refresh }
    // Shell is injected into #accountTab, styles injected into <head> once.
    // ──────────────────────────────────────────────────────────────────────────

    const API = {
        me:                '/api/me',
        passwordReset:     '/api/me/password-reset',
        emailRequest:      '/api/me/email/request',
        sessions:          '/api/me/sessions',
        sessionRevoke:     (id) => `/api/me/sessions/${id}`,
        sessionsRevokeAll: '/api/me/sessions/revoke-all',
        token:             '/api/me/token',
        contributors:      '/api/me/contributors',
        contributor:       (id) => `/api/me/contributors/${id}`,
        tags:              '/api/me/tags',
        preferences:       '/api/me/preferences',
    };

    const NAV_SECTIONS = [
        { id: 'identity',     icon: '👤', label: 'Identity' },
        { id: 'security',     icon: '🔒', label: 'Security' },
        { id: 'api-token',    icon: '🔑', label: 'API Token' },
        { id: 'contributors', icon: '🤝', label: 'Contributors' },
        { id: 'tags',         icon: '🏷️', label: 'Tags' },
        { id: 'preferences',  icon: '⚙️', label: 'Preferences' },
    ];

    let _currentSection = 'identity';

    // ── helpers ───────────────────────────────────────────────────────────────

    function apiFetch(url, opts) {
        return window.authFetch ? window.authFetch(url, opts) : fetch(url, opts);
    }

    function toast(msg, type) {
        if (window.showToast) { window.showToast(msg, type || 'success'); return; }
        alert(msg);
    }

    /** Minimal DOM builder — avoids innerHTML entirely */
    function el(tag, props, ...kids) {
        const e = document.createElement(tag);
        if (props) {
            Object.entries(props).forEach(([k, v]) => {
                if (v == null) return;
                if (k === 'className') { e.className = v; }
                else if (k === 'style' && typeof v === 'string') { e.style.cssText = v; }
                else if (k.startsWith('on') && typeof v === 'function') {
                    e.addEventListener(k.slice(2).toLowerCase(), v);
                } else { e[k] = v; }
            });
        }
        kids.flat().forEach(c => {
            if (c == null) return;
            e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return e;
    }

    function _inp(opts) {
        return el('input', Object.assign({ className: 'am-input' }, opts || {}));
    }

    function _btn(label, variant, onClick) {
        return el('button', { className: `am-btn am-btn-${variant}`, onClick }, label);
    }

    function _field(label, node, helpText) {
        const wrap = el('div', { className: 'am-field' });
        wrap.appendChild(el('div', { className: 'am-field-label' }, label));
        wrap.appendChild(node);
        if (helpText) wrap.appendChild(el('div', { className: 'am-field-help' }, helpText));
        return wrap;
    }

    function _card(...children) {
        const c = el('div', { className: 'am-card' });
        children.forEach(ch => ch && c.appendChild(ch));
        return c;
    }

    function _timeAgo(dateStr) {
        if (!dateStr) return 'Unknown';
        const diff = Date.now() - new Date(dateStr).getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return 'Just now';
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    // ── CSS injection ─────────────────────────────────────────────────────────

    function _injectStyles() {
        if (document.getElementById('account-module-styles')) return;
        const s = document.createElement('style');
        s.id = 'account-module-styles';
        s.textContent = `
        /* Account Module shell */
        .am-shell{display:flex;height:100%;gap:0}
        .am-nav{width:200px;flex-shrink:0;min-height:0;padding:1.5rem 0.75rem;display:flex;flex-direction:column;gap:0.25rem;border-right:1px solid rgba(148,163,184,.12);overflow-y:auto}
        .am-nav-btn{background:transparent;border:none;color:#94a3b8;padding:.6rem .9rem;border-radius:.5rem;cursor:pointer;font-size:.875rem;text-align:left;font-weight:500;transition:all .15s;display:flex;align-items:center;gap:.5rem;width:100%;white-space:nowrap}
        .am-nav-btn:hover{background:rgba(148,163,184,.1);color:#e2e8f0}
        .am-nav-btn.active{background:rgba(124,58,237,.18);color:#c084fc;font-weight:600}
        .am-content{flex:1;min-height:0;padding:1.5rem 2rem;overflow-y:auto;max-width:720px}
        .am-section-title{font-size:1.2rem;font-weight:700;color:#e2e8f0;margin:0 0 1.25rem}
        .am-card{background:rgba(15,23,42,.6);border:1px solid rgba(148,163,184,.15);border-radius:.75rem;padding:1.25rem;margin-bottom:1rem}
        .am-card-label{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:.3rem}
        .am-card-value{color:#e2e8f0;font-size:.95rem;font-weight:500;margin-bottom:.75rem}
        .am-card-value:last-child{margin-bottom:0}
        .am-field{margin-bottom:.875rem}
        .am-field-label{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:.35rem}
        .am-field-help{font-size:.75rem;color:#475569;margin-top:.35rem}
        .am-input{width:100%;background:rgba(15,23,42,.8);border:1px solid rgba(148,163,184,.2);border-radius:.5rem;padding:.6rem .9rem;color:#e2e8f0;font-size:.875rem;box-sizing:border-box;outline:none;font-family:inherit}
        .am-input:focus{border-color:rgba(124,58,237,.5)}
        .am-btn{padding:.5rem 1.15rem;border-radius:.5rem;border:none;font-weight:600;font-size:.875rem;cursor:pointer;transition:all .15s;font-family:inherit}
        .am-btn-primary{background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff}
        .am-btn-primary:hover{filter:brightness(1.1)}
        .am-btn-primary:disabled{opacity:.55;cursor:not-allowed;filter:none}
        .am-btn-danger{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#f87171}
        .am-btn-danger:hover{background:rgba(239,68,68,.22)}
        .am-btn-danger:disabled{opacity:.55;cursor:not-allowed}
        .am-btn-ghost{background:rgba(148,163,184,.1);border:1px solid rgba(148,163,184,.2);color:#94a3b8}
        .am-btn-ghost:hover{background:rgba(148,163,184,.2);color:#e2e8f0}
        .am-btn-row{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.75rem}
        .am-token-box{font-family:monospace;font-size:.8rem;background:rgba(0,0,0,.45);border:1px solid rgba(148,163,184,.2);border-radius:.5rem;padding:.75rem 1rem;color:#a3e635;word-break:break-all;user-select:all;margin:.75rem 0}
        .am-tag-pill{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .6rem;background:rgba(168,85,247,.13);border:1px solid rgba(168,85,247,.22);border-radius:99px;color:#c084fc;font-size:.8rem;margin:.2rem}
        .am-tag-count{font-size:.7rem;color:#a78bfa}
        .am-session-row{display:flex;align-items:center;justify-content:space-between;padding:.7rem 1rem;border-bottom:1px solid rgba(148,163,184,.07);gap:.6rem}
        .am-session-row:last-child{border-bottom:none}
        .am-session-info{flex:1;min-width:0}
        .am-session-main{color:#e2e8f0;font-size:.875rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .am-session-sub{font-size:.72rem;color:#64748b;margin-top:.12rem}
        .am-badge-current{color:#10b981;font-size:.7rem;font-weight:600;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);border-radius:99px;padding:.12rem .45rem;white-space:nowrap;flex-shrink:0}
        .am-contrib-row{display:flex;align-items:center;justify-content:space-between;padding:.7rem 0;border-bottom:1px solid rgba(148,163,184,.07);gap:.75rem}
        .am-contrib-row:last-child{border-bottom:none}
        .am-back-btn{color:#64748b;font-size:.8rem;border-bottom:1px solid rgba(148,163,184,.1);margin-bottom:.5rem;padding-bottom:.9rem!important}
        .am-back-btn:hover{color:#94a3b8!important;background:transparent!important}
        .am-empty{color:#64748b;font-size:.875rem;padding:2rem 0;text-align:center}
        .am-warn{font-size:.72rem;color:#f59e0b;margin-top:.35rem}
        .am-separator{height:1px;background:rgba(148,163,184,.1);margin:.75rem 0}
        select.am-input{appearance:auto}
        @media(max-width:640px){
            .am-shell{flex-direction:column}
            .am-nav{width:100%;min-height:auto;flex-direction:row;overflow-x:auto;overflow-y:visible;padding:.75rem;border-right:none;border-bottom:1px solid rgba(148,163,184,.12);gap:.4rem}
            .am-nav-btn{flex-shrink:0;font-size:.8rem;padding:.5rem .75rem}
            .am-content{padding:1rem}
        }`;
        document.head.appendChild(s);
    }

    // ── shell ─────────────────────────────────────────────────────────────────

    function _buildShell() {
        const tab = document.getElementById('accountTab');
        if (!tab) return;
        if (tab.dataset.accountInit === '1') return;
        tab.dataset.accountInit = '1';

        _injectStyles();

        const shell = el('div', { className: 'am-shell' });
        const nav = el('nav', { className: 'am-nav', id: 'am-nav' });
        const content = el('div', { className: 'am-content', id: 'am-content' });

        // Back button — always first in nav
        nav.appendChild(el('button', {
            className: 'am-nav-btn am-back-btn',
            title: 'Back to Books',
            onClick: () => { if (typeof window.switchTab === 'function') window.switchTab('books'); },
        }, '← Books'));

        NAV_SECTIONS.forEach(s => {
            nav.appendChild(el('button', {
                className: 'am-nav-btn' + (s.id === _currentSection ? ' active' : ''),
                id: `am-nav-${s.id}`,
                onClick: () => _loadSection(s.id),
            }, s.icon + '\u00a0' + s.label));
        });

        shell.appendChild(nav);
        shell.appendChild(content);
        tab.replaceChildren(shell);
    }

    function _activateNav(sectionId) {
        document.querySelectorAll('.am-nav-btn').forEach(b => b.classList.remove('active'));
        const btn = document.getElementById(`am-nav-${sectionId}`);
        if (btn) btn.classList.add('active');
        _currentSection = sectionId;
    }

    async function _loadSection(sectionId) {
        _activateNav(sectionId);
        const content = document.getElementById('am-content');
        if (!content) return;
        content.replaceChildren(el('div', { className: 'am-empty' }, 'Loading…'));
        try {
            switch (sectionId) {
                case 'identity':     await _sIdentity(content);     break;
                case 'security':     await _sSecurity(content);     break;
                case 'api-token':    await _sApiToken(content);     break;
                case 'contributors': await _sContributors(content); break;
                case 'tags':         await _sTags(content);         break;
                case 'preferences':  await _sPreferences(content);  break;
            }
        } catch (err) {
            content.replaceChildren(el('div', { style: 'color:#ef4444;padding:2rem;font-size:.875rem;' },
                '⚠️ ' + (err.message || 'Unexpected error')));
        }
    }

    // ── IDENTITY ──────────────────────────────────────────────────────────────

    async function _sIdentity(content) {
        const res = await apiFetch(API.me);
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const u = await res.json();

        const frag = document.createDocumentFragment();
        frag.appendChild(el('h2', { className: 'am-section-title' }, '👤 Identity'));

        const infoCard = _card(
            (() => {
                const wrap = el('div');
                [['Email', u.email], ['Member Since', new Date(u.member_since).toLocaleDateString()], ['Tenant Handle', u.tenant_schema]].forEach(([label, value]) => {
                    wrap.appendChild(el('div', { className: 'am-card-label' }, label));
                    wrap.appendChild(el('div', { className: 'am-card-value' }, value));
                });
                return wrap;
            })()
        );
        frag.appendChild(infoCard);

        // Change email form
        const emailTitle = el('div', { className: 'am-card-label', style: 'margin-bottom:.75rem;' }, 'Change Email Address');
        const newEmailIn = _inp({ type: 'email', placeholder: 'New email address' });
        const sendBtn = _btn('Send Verification', 'primary', async () => {
            const addr = newEmailIn.value.trim();
            if (!addr) { toast('Enter a new email address', 'error'); return; }
            sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
            try {
                const r = await apiFetch(API.emailRequest, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newEmail: addr })
                });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || 'Failed');
                toast('Verification link sent to ' + addr, 'success');
                newEmailIn.value = '';
            } catch (e) { toast(e.message, 'error'); }
            finally { sendBtn.disabled = false; sendBtn.textContent = 'Send Verification'; }
        });
        const help = el('div', { className: 'am-field-help' }, "A verification link will be sent to the new address. You'll also get a security alert at your current email.");
        frag.appendChild(_card(emailTitle, _field('', newEmailIn), sendBtn, help));

        content.replaceChildren(frag);
    }

    // ── SECURITY ──────────────────────────────────────────────────────────────

    async function _sSecurity(content) {
        const [sessRes, logRes] = await Promise.all([
            apiFetch(API.sessions),
            apiFetch('/api/me/security-log')
        ]);
        if (!sessRes.ok) throw new Error(`Sessions: ${sessRes.status}`);
        const { sessions } = await sessRes.json();
        const { events } = logRes.ok ? await logRes.json() : { events: [] };

        const frag = document.createDocumentFragment();
        frag.appendChild(el('h2', { className: 'am-section-title' }, '🔒 Security'));

        // 1 — Change password
        const passCard = _card(
            el('div', { className: 'am-card-label', style: 'margin-bottom:.5rem;' }, 'Change Password'),
            el('p', { style: 'color:#94a3b8;font-size:.875rem;margin:0 0 .75rem;' },
                "We'll send a reset link to your account email. The link expires in 15 minutes."),
            (() => {
                const btn = _btn('Send Reset Email', 'primary', async () => {
                    btn.disabled = true; btn.textContent = 'Sending…';
                    try {
                        const r = await apiFetch(API.passwordReset, { method: 'POST' });
                        const d = await r.json();
                        if (!r.ok) throw new Error(d.error || 'Failed');
                        toast('Reset link sent — check your inbox.', 'success');
                    } catch (e) { toast(e.message, 'error'); }
                    finally { btn.disabled = false; btn.textContent = 'Send Reset Email'; }
                });
                return btn;
            })()
        );
        frag.appendChild(passCard);

        // 2 — Active sessions
        const sessTitle = el('div', { className: 'am-card-label', style: 'margin-bottom:.75rem;' }, 'Active Sessions');
        const sessCard = el('div', { className: 'am-card' });
        sessCard.appendChild(sessTitle);

        if (!sessions.length) {
            sessCard.appendChild(el('div', { className: 'am-empty', style: 'padding:1rem 0;' }, 'No active sessions found.'));
        } else {
            const listWrap = el('div', { style: 'border:1px solid rgba(148,163,184,.12);border-radius:.5rem;overflow:hidden;margin-bottom:.75rem;' });
            sessions.forEach(s => {
                const icon = s.device_type === 'Mobile' ? '📱' : s.device_type === 'Tablet' ? '📲' : '🖥️';
                const row = el('div', { className: 'am-session-row' });
                const info = el('div', { className: 'am-session-info' });
                info.appendChild(el('div', { className: 'am-session-main' },
                    `${icon} ${s.browser || 'Unknown'} on ${s.os || 'Unknown OS'}`));
                info.appendChild(el('div', { className: 'am-session-sub' },
                    `${s.location || s.ip_address || 'Unknown location'} · ${_timeAgo(s.last_activity)}`));
                row.appendChild(info);
                if (s.is_current) {
                    row.appendChild(el('span', { className: 'am-badge-current' }, '● Current'));
                } else {
                    const rBtn = _btn('Revoke', 'danger', async () => {
                        rBtn.disabled = true;
                        try {
                            const r = await apiFetch(API.sessionRevoke(s.id), { method: 'DELETE' });
                            if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
                            row.remove();
                            toast('Session revoked', 'success');
                        } catch (e) { toast(e.message, 'error'); rBtn.disabled = false; }
                    });
                    rBtn.style.cssText = 'font-size:.75rem;padding:.3rem .7rem;';
                    row.appendChild(rBtn);
                }
                listWrap.appendChild(row);
            });
            sessCard.appendChild(listWrap);
            const revokeAllBtn = _btn('🚫 Revoke All Other Sessions', 'danger', async () => {
                if (!confirm('Revoke all sessions except the current one?')) return;
                revokeAllBtn.disabled = true;
                try {
                    const r = await apiFetch(API.sessionsRevokeAll, { method: 'POST' });
                    const d = await r.json();
                    if (!r.ok) throw new Error(d.error);
                    toast(`Revoked ${d.count} session(s)`, 'success');
                    await _sSecurity(content);
                } catch (e) { toast(e.message, 'error'); revokeAllBtn.disabled = false; }
            });
            sessCard.appendChild(revokeAllBtn);
        }
        frag.appendChild(sessCard);

        // 3 — Security log
        const logTitle = el('div', { className: 'am-card-label', style: 'margin-bottom:.75rem;' }, 'Recent Security Events');
        const logCard = el('div', { className: 'am-card' });
        logCard.appendChild(logTitle);

        if (!events.length) {
            logCard.appendChild(el('div', { className: 'am-empty', style: 'padding:1rem 0;' }, 'No events recorded yet.'));
        } else {
            const actionIcon = { LOGIN: '🔓', LOGOUT: '🔐', REVOKE_SESSION: '🚫', REVOKE_ALL_SESSIONS: '🚫🚫',
                                  UPDATE_EMAIL: '✉️', UPDATE_PASSWORD: '🔑', SIGNUP: '✨' };
            const actionLabel = { LOGIN: 'Sign in', LOGOUT: 'Sign out', REVOKE_SESSION: 'Session revoked',
                                   REVOKE_ALL_SESSIONS: 'All sessions revoked', UPDATE_EMAIL: 'Email changed',
                                   UPDATE_PASSWORD: 'Password changed', SIGNUP: 'Account created' };
            events.forEach(ev => {
                const row = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-bottom:1px solid rgba(148,163,184,.07);gap:.5rem;' });
                const left = el('div');
                left.appendChild(el('div', { style: 'color:#e2e8f0;font-size:.875rem;' },
                    `${actionIcon[ev.action_type] || '•'} ${actionLabel[ev.action_type] || ev.action_type}`));
                left.appendChild(el('div', { style: 'font-size:.72rem;color:#64748b;margin-top:.1rem;' },
                    ev.ip_address || 'Unknown IP'));
                row.appendChild(left);
                row.appendChild(el('div', { style: 'font-size:.72rem;color:#64748b;flex-shrink:0;' },
                    ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '—'));
                logCard.appendChild(row);
            });
        }
        frag.appendChild(logCard);
        content.replaceChildren(frag);
    }

    // ── API TOKEN ─────────────────────────────────────────────────────────────

    async function _sApiToken(content) {
        const res = await apiFetch(API.token);
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const data = await res.json();

        const frag = document.createDocumentFragment();
        frag.appendChild(el('h2', { className: 'am-section-title' }, '🔑 API Token'));

        frag.appendChild(_card(el('p', { style: 'color:#94a3b8;font-size:.875rem;margin:0;' },
            'Your personal token grants read access to all your books. Use it as: Authorization: Bearer <token>. ' +
            'Generating a new token immediately revokes the previous one.')));

        const tokenCard = _card();
        if (data.exists) {
            tokenCard.appendChild(el('div', { className: 'am-card-label' }, 'Active since'));
            tokenCard.appendChild(el('div', { className: 'am-card-value' }, new Date(data.created_at).toLocaleString()));
            if (data.last_used_at) {
                tokenCard.appendChild(el('div', { className: 'am-card-label' }, 'Last used'));
                tokenCard.appendChild(el('div', { className: 'am-card-value' }, new Date(data.last_used_at).toLocaleString()));
            }
            tokenCard.appendChild(el('div', { className: 'am-separator' }));
        }

        const pwIn = _inp({ type: 'password', placeholder: 'Current password (required to generate)' });
        tokenCard.appendChild(_field('', pwIn));

        const btnRow = el('div', { className: 'am-btn-row' });
        const genBtn = _btn(data.exists ? 'Regenerate Token' : 'Generate Token', 'primary', async () => {
            const pw = pwIn.value;
            if (!pw) { toast('Enter your current password', 'error'); return; }
            genBtn.disabled = true; genBtn.textContent = 'Generating…';
            if (revokeBtn) revokeBtn.disabled = true;
            try {
                const r = await apiFetch(API.token, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ currentPassword: pw })
                });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || 'Failed');
                pwIn.value = '';
                // Non-dismissable token reveal — buttons stay disabled until acknowledged
                _showTokenRevealWithAck(tokenCard, d.token,
                    'Your API Token — copy it now. This is the only time it will be shown.',
                    () => _sApiToken(content));
                toast('Token generated. You must copy and acknowledge before continuing.', 'success');
                // Keep buttons disabled until acknowledge — _showTokenRevealWithAck handles reload
                return;
            } catch (e) {
                toast(e.message, 'error');
                genBtn.disabled = false; genBtn.textContent = data.exists ? 'Regenerate Token' : 'Generate Token';
                if (revokeBtn) revokeBtn.disabled = false;
            }
        });
        btnRow.appendChild(genBtn);

        let revokeBtn = null;
        if (data.exists) {
            revokeBtn = _btn('Revoke', 'danger', async () => {
                if (!confirm('Revoke your API token? All clients using it will stop working.')) return;
                revokeBtn.disabled = true;
                try {
                    const r = await apiFetch(API.token, { method: 'DELETE' });
                    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
                    toast('Token revoked', 'success');
                    await _sApiToken(content);
                } catch (e) { toast(e.message, 'error'); revokeBtn.disabled = false; }
            });
            btnRow.appendChild(revokeBtn);
        }
        tokenCard.appendChild(btnRow);
        frag.appendChild(tokenCard);
        content.replaceChildren(frag);
    }

    // ── CONTRIBUTORS ──────────────────────────────────────────────────────────

    async function _sContributors(content) {
        const res = await apiFetch(API.contributors);
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const { contributors } = await res.json();

        const frag = document.createDocumentFragment();
        frag.appendChild(el('h2', { className: 'am-section-title' }, '🤝 Contributors'));
        frag.appendChild(el('p', { style: 'color:#94a3b8;font-size:.875rem;margin:0 0 1rem;' },
            'Grant read-only access to specific books for other users. Each grant produces a unique Bearer token — GET requests only, write operations are never permitted.'));

        if (contributors.length) {
            const listCard = el('div', { className: 'am-card', style: 'padding:0 1.25rem;margin-bottom:1rem;' });
            contributors.forEach(c => {
                const row = el('div', { className: 'am-contrib-row' });
                const info = el('div', { style: 'flex:1;min-width:0;' });
                info.appendChild(el('div', { style: 'color:#e2e8f0;font-size:.875rem;font-weight:500;' }, c.granted_to_email));
                info.appendChild(el('div', { style: 'font-size:.72rem;color:#64748b;margin-top:.12rem;' },
                    `${(c.book_fractal_ids || []).length} book(s) · Since ${new Date(c.created_at).toLocaleDateString()}`));
                row.appendChild(info);
                const rBtn = _btn('Revoke', 'danger', async () => {
                    if (!confirm(`Revoke access for ${c.granted_to_email}?`)) return;
                    rBtn.disabled = true;
                    try {
                        const r = await apiFetch(API.contributor(c.id), { method: 'DELETE' });
                        if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
                        row.remove();
                        toast('Contributor access revoked', 'success');
                    } catch (e) { toast(e.message, 'error'); rBtn.disabled = false; }
                });
                rBtn.style.cssText = 'font-size:.75rem;padding:.3rem .7rem;flex-shrink:0;';
                row.appendChild(rBtn);
                listCard.appendChild(row);
            });
            frag.appendChild(listCard);
        }

        // Grant form
        const grantCard = _card(
            el('div', { className: 'am-card-label', style: 'margin-bottom:.75rem;' }, 'Grant Access')
        );
        const emailIn = _inp({ type: 'email', placeholder: 'Contributor email' });
        const booksIn = _inp({ type: 'text', placeholder: 'Book fractal IDs (comma-separated)' });
        const pwIn    = _inp({ type: 'password', placeholder: 'Your password (required)' });
        grantCard.appendChild(_field('Email', emailIn));
        grantCard.appendChild(_field('Books', booksIn, 'Paste the fractal IDs shown in book settings, separated by commas.'));
        grantCard.appendChild(_field('Password', pwIn));

        const grantBtn = _btn('Grant Access', 'primary', async () => {
            const email = emailIn.value.trim();
            const ids = booksIn.value.split(',').map(s => s.trim()).filter(Boolean);
            const pw = pwIn.value;
            if (!email || !ids.length) { toast('Email and at least one book ID required', 'error'); return; }
            if (!pw) { toast('Enter your password to confirm', 'error'); return; }
            grantBtn.disabled = true; grantBtn.textContent = 'Granting…';
            try {
                const r = await apiFetch(API.contributors, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ grantedToEmail: email, bookFractalIds: ids, currentPassword: pw })
                });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || 'Failed');
                emailIn.value = ''; booksIn.value = ''; pwIn.value = '';
                _showTokenReveal(grantCard, d.token, `Contributor token for ${email} — share this once`);
                toast('Access granted. Share the token with ' + email, 'success');
                setTimeout(() => _sContributors(content), 3500);
            } catch (e) { toast(e.message, 'error'); }
            finally { grantBtn.disabled = false; grantBtn.textContent = 'Grant Access'; }
        });
        grantCard.appendChild(grantBtn);
        frag.appendChild(grantCard);
        content.replaceChildren(frag);
    }

    // ── TAGS ──────────────────────────────────────────────────────────────────

    async function _sTags(content) {
        const res = await apiFetch(API.tags);
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const { tags } = await res.json();

        const frag = document.createDocumentFragment();
        frag.appendChild(el('h2', { className: 'am-section-title' }, '🏷️ Tags'));
        frag.appendChild(el('p', { style: 'color:#94a3b8;font-size:.875rem;margin:0 0 1rem;' },
            'All tags across your message drops, ordered by frequency. Sourced from the PITA mesh on ingested drops.'));

        if (!tags.length) {
            frag.appendChild(_card(el('div', { className: 'am-empty' },
                'No tags yet. Tags appear here as messages are ingested and tagged.')));
            content.replaceChildren(frag);
            return;
        }

        const cloud = el('div', { style: 'display:flex;flex-wrap:wrap;gap:.2rem;' });
        tags.forEach(t => {
            const pill = el('span', { className: 'am-tag-pill',
                style: 'cursor:pointer;transition:opacity .15s;',
                title: `Search drops tagged #${t.tag}`,
                onClick: () => {
                    // Switch to books tab and fire PITA mesh search in Eve sidebar
                    if (typeof window.switchTab === 'function') window.switchTab('books');
                    const sb = document.getElementById('searchBox');
                    if (sb) {
                        sb.value = '#' + t.tag;
                        sb.dispatchEvent(new Event('input', { bubbles: true }));
                        sb.focus();
                    }
                }},
            '#' + t.tag,
            el('span', { className: 'am-tag-count' }, String(t.count)));
        pill.addEventListener('mouseenter', () => { pill.style.opacity = '.75'; });
        pill.addEventListener('mouseleave', () => { pill.style.opacity = '1'; });
        cloud.appendChild(pill);
        });
        frag.appendChild(_card(cloud));
        content.replaceChildren(frag);
    }

    // ── PREFERENCES ───────────────────────────────────────────────────────────

    async function _sPreferences(content) {
        const res = await apiFetch(API.me);
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const { preferences: prefs } = await res.json();
        const p = prefs || {};

        const frag = document.createDocumentFragment();
        frag.appendChild(el('h2', { className: 'am-section-title' }, '⚙️ Preferences'));

        const card = _card();

        // Locale picker
        const locSel = el('select', { className: 'am-input' });
        [['en', 'English'], ['id', 'Bahasa Indonesia'], ['zh', '中文 (Mandarin)']].forEach(([v, lbl]) => {
            const opt = el('option', { value: v }, lbl);
            if ((p.locale || 'en') === v) opt.selected = true;
            locSel.appendChild(opt);
        });
        card.appendChild(_field('Locale / Language', locSel, 'Used for AI query interpretation and monthly email formatting.'));

        // Monthly email backup default
        const chkLabel = el('label', { style: 'display:flex;align-items:center;gap:.6rem;cursor:pointer;' });
        const chk = el('input', { type: 'checkbox' });
        chk.checked = p.monthlyEmailBackupDefault !== false;
        chkLabel.appendChild(chk);
        chkLabel.appendChild(el('span', { style: 'color:#e2e8f0;font-size:.875rem;' },
            'Enable monthly email backup by default for new books'));
        card.appendChild(_field('', chkLabel));

        const saveBtn = _btn('Save Preferences', 'primary', async () => {
            saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
            try {
                const r = await apiFetch(API.preferences, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ locale: locSel.value, monthlyEmailBackupDefault: chk.checked })
                });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || 'Failed');
                toast('Preferences saved', 'success');
            } catch (e) { toast(e.message, 'error'); }
            finally { saveBtn.disabled = false; saveBtn.textContent = 'Save Preferences'; }
        });
        saveBtn.style.marginTop = '.25rem';
        card.appendChild(saveBtn);
        frag.appendChild(card);
        content.replaceChildren(frag);
    }

    // ── SHARED: token reveal widget ───────────────────────────────────────────

    function _showTokenReveal(container, token, labelText) {
        const existing = container.querySelector('.am-token-reveal');
        if (existing) existing.remove();

        const box = el('div', { className: 'am-token-reveal' });
        box.appendChild(el('div', { className: 'am-warn', style: 'margin-bottom:.5rem;' },
            '⚠️ ' + labelText));
        box.appendChild(el('div', { className: 'am-token-box' }, token));

        const copyBtn = _btn('Copy', 'ghost', () => {
            navigator.clipboard.writeText(token).then(() => {
                copyBtn.textContent = '✓ Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2500);
            }).catch(() => toast('Copy failed — select and copy manually', 'error'));
        });
        copyBtn.style.fontSize = '.8rem';
        box.appendChild(copyBtn);
        container.appendChild(box);
    }

    /** Like _showTokenReveal but non-dismissable: renders a prominent acknowledge
     *  button that the user must click before continuing. onAcknowledge is called
     *  after they confirm, reloading the section so it shows the token-exists state. */
    function _showTokenRevealWithAck(container, token, labelText, onAcknowledge) {
        const existing = container.querySelector('.am-token-reveal');
        if (existing) existing.remove();

        const box = el('div', { className: 'am-token-reveal',
            style: 'border:2px solid rgba(234,179,8,.4);border-radius:.5rem;padding:1rem;margin-top:.75rem;' });
        box.appendChild(el('div', { className: 'am-warn', style: 'margin-bottom:.5rem;' },
            '⚠️ ' + labelText));

        const tokenBox = el('div', { className: 'am-token-box',
            style: 'word-break:break-all;font-family:monospace;font-size:.82rem;background:rgba(15,23,42,.8);padding:.75rem;border-radius:.375rem;border:1px solid rgba(148,163,184,.15);color:#a3e635;margin:.5rem 0;' },
            token);
        box.appendChild(tokenBox);

        let copied = false;
        const copyBtn = _btn('📋 Copy', 'ghost', () => {
            navigator.clipboard.writeText(token).then(() => {
                copied = true;
                copyBtn.textContent = '✓ Copied!';
                ackBtn.style.opacity = '1';
                ackBtn.disabled = false;
            }).catch(() => toast('Copy failed — select and copy manually', 'error'));
        });
        copyBtn.style.cssText = 'font-size:.8rem;margin-right:.5rem;';

        const ackBtn = _btn('I\'ve saved this token ✓', 'primary', () => {
            if (!copied) {
                toast('Please copy the token first.', 'error');
                return;
            }
            box.remove();
            if (typeof onAcknowledge === 'function') onAcknowledge();
        });
        ackBtn.style.cssText = 'opacity:.4;font-size:.85rem;';
        ackBtn.disabled = true;
        ackBtn.title = 'Copy the token first, then acknowledge';

        const btnRow = el('div', { style: 'display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem;' });
        btnRow.appendChild(copyBtn);
        btnRow.appendChild(ackBtn);
        box.appendChild(btnRow);

        box.appendChild(el('div', { style: 'font-size:.72rem;color:#94a3b8;margin-top:.5rem;' },
            'The acknowledge button unlocks after you copy. Once acknowledged the token cannot be retrieved again.'));
        container.appendChild(box);
    }

    // ── email change confirmation ──────────────────────────────────────────────

    function _handleEmailChangeParam() {
        const params = new URLSearchParams(window.location.search);
        if (!params.has('email_change')) return;
        const status = params.get('email_change');
        const reason = params.get('reason') || '';
        if (status === 'success') {
            toast('Email address updated successfully!', 'success');
        } else {
            const map = { missing_token: 'Invalid link.', invalid: 'Link not found or invalid.', used: 'Link already used.', expired: 'Link has expired.', internal: 'Server error.' };
            toast('Email change failed — ' + (map[reason] || reason || 'Unknown error'), 'error');
        }
        const url = new URL(window.location.href);
        url.searchParams.delete('email_change');
        url.searchParams.delete('reason');
        window.history.replaceState({}, '', url.toString());
    }

    // ── public API ────────────────────────────────────────────────────────────

    function init() {
        _buildShell();
        _handleEmailChangeParam();
        _loadSection('identity');
    }

    function refresh() {
        if (!document.getElementById('am-content')) {
            _buildShell();
        }
        _loadSection(_currentSection);
    }

    window.AccountModule = { init, refresh };
})();
