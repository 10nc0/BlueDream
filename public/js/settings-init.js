'use strict';
(async function () {
    try {
        const res = await window.authFetch('/api/auth/status');
        if (!res.ok || res.status === 401) {
            window.location.replace('/login.html');
            return;
        }
        const data = await res.json();
        if (!data.authenticated) {
            window.location.replace('/login.html');
            return;
        }
    } catch (e) {
        window.location.replace('/login.html');
        return;
    }

    if (window.AccountModule) {
        window.AccountModule.init();
    } else {
        const tab = document.getElementById('accountTab');
        if (tab) {
            tab.innerHTML = '<div style="color:#ef4444;padding:3rem 2rem;text-align:center">⚠️ Settings module failed to load. Please hard-refresh.</div>';
        }
    }
})();
