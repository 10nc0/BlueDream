window.Nyan = window.Nyan || {};

window.Nyan.DataSync = (function() {
    const _fetch = window.authFetch || fetch;
    
    async function request(url, options = {}) {
        const response = await _fetch(url, options);
        return response;
    }
    
    async function get(url) {
        return request(url, { method: 'GET' });
    }
    
    async function post(url, data) {
        return request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    }
    
    async function put(url, data) {
        return request(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    }
    
    async function del(url) {
        return request(url, { method: 'DELETE' });
    }
    
    async function getJSON(url) {
        const res = await get(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }
    
    async function postJSON(url, data) {
        const res = await post(url, data);
        return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    }
    
    async function putJSON(url, data) {
        const res = await put(url, data);
        return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    }
    
    async function delJSON(url) {
        const res = await del(url);
        return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    }

    return {
        request,
        get,
        post,
        put,
        del,
        getJSON,
        postJSON,
        putJSON,
        delJSON
    };
})();

console.log('🔄 Nyan.DataSync loaded');
