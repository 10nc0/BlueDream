window.Nyan = window.Nyan || {};

window.Nyan.AuthService = (function() {
    const roleColors = {
        'dev': '#ffffff',
        'admin': '#10b981',
        'user': '#60a5fa',
        'read-only': '#f59e0b',
        'write-only': '#3b82f6'
    };

    let _refreshPromise = null;
    let _redirecting = false;

    function forceLogout() {
        if (_redirecting) return;
        _redirecting = true;
        clearTokens();
        console.log('🚪 Session expired — redirecting to login');
        window.location.href = '/login.html';
    }

    async function _doRefresh() {
        const refreshToken = localStorage.getItem('refreshToken');
        if (!refreshToken) return null;

        const refreshResponse = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        });

        if (refreshResponse.ok) {
            const refreshData = await refreshResponse.json();
            localStorage.setItem('accessToken', refreshData.accessToken);
            if (refreshData.refreshToken) {
                localStorage.setItem('refreshToken', refreshData.refreshToken);
            }
            return refreshData.accessToken;
        }
        return null;
    }

    async function refreshAccessToken() {
        if (_refreshPromise) return _refreshPromise;

        _refreshPromise = _doRefresh().finally(() => { _refreshPromise = null; });
        return _refreshPromise;
    }

    async function authFetch(url, options = {}) {
        if (_redirecting) return new Response(null, { status: 401 });

        let accessToken = localStorage.getItem('accessToken');
        
        options.headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };
        
        if (accessToken) {
            options.headers['Authorization'] = `Bearer ${accessToken}`;
        }
        
        let response = await fetch(url, options);
        
        if (response.status === 401 && accessToken) {
            try {
                const newToken = await refreshAccessToken();
                if (newToken) {
                    options.headers['Authorization'] = `Bearer ${newToken}`;
                    response = await fetch(url, options);
                } else {
                    forceLogout();
                    return response;
                }
            } catch (refreshError) {
                console.error('Token refresh failed:', refreshError);
                forceLogout();
                return response;
            }
        }
        
        return response;
    }

    function clearTokens() {
        try {
            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
            console.log('✅ Cleared auth tokens');
        } catch (e) {
            console.log('⚠️ Token clear error:', e);
        }
    }

    function clearAllStorage() {
        try {
            localStorage.clear();
            sessionStorage.clear();
            console.log('✅ Cleared localStorage and sessionStorage');
        } catch (e) {
            console.log('⚠️ Storage clear error (Safari private mode?):', e);
        }
        
        document.cookie.split(";").forEach(function(c) { 
            document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); 
        });
        console.log('✅ Cleared all cookies');
    }

    window.authFetch = authFetch;
    
    console.log('🔐 Nyan.AuthService loaded');
    
    return {
        authFetch,
        refreshAccessToken,
        forceLogout,
        clearTokens,
        clearAllStorage,
        roleColors
    };
})();
