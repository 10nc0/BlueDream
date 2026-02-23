window.Nyan = window.Nyan || {};

window.Nyan.AuthService = (function() {
    const roleColors = {
        'dev': '#ffffff',
        'admin': '#10b981',
        'user': '#60a5fa',
        'read-only': '#f59e0b',
        'write-only': '#ef4444'
    };

    async function authFetch(url, options = {}) {
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
            const refreshToken = localStorage.getItem('refreshToken');
            
            if (refreshToken) {
                try {
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
                        
                        options.headers['Authorization'] = `Bearer ${refreshData.accessToken}`;
                        response = await fetch(url, options);
                    } else {
                        clearTokens();
                        window.location.href = '/login.html';
                        return response;
                    }
                } catch (refreshError) {
                    console.error('Token refresh failed:', refreshError);
                    clearTokens();
                    window.location.href = '/login.html';
                    return response;
                }
            } else {
                window.location.href = '/login.html';
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
        clearTokens,
        clearAllStorage,
        roleColors
    };
})();
