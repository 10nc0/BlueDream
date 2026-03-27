(function() {
    'use strict';

    const _S = window.Nyan?.StateService;
    if (!_S) {
        console.error('MessagesModule: StateService not found');
        return;
    }

    async function fetchMessages(bookId, options = {}) {
        const { before = null, limit = 50, source = 'all' } = options;
        
        if (!bookId || !(window.Nyan.BOOK_ID_PATTERN || /^(?:dev_)?(bridge|book|msg)_t\d+_[a-f0-9]+$|^twilio_book_\d+_\d+$/).test(bookId)) {
            console.error('MessagesModule: Invalid book ID format:', bookId);
            return { success: false, error: 'Invalid book ID' };
        }
        
        try {
            let url = `/api/books/${bookId}/messages?limit=${limit}&source=${source}`;
            if (before) {
                url += `&before=${before}`;
            }
            
            console.log(`MessagesModule: Fetching messages for ${bookId} (source: ${source}, before: ${before || 'none'})`);
            const response = await window.authFetch(url);
            
            if (!response.ok) {
                console.error(`MessagesModule: API returned ${response.status}`);
                return { success: false, error: `HTTP ${response.status}` };
            }
            
            const data = await response.json();
            return {
                success: true,
                messages: data.messages || [],
                hasMore: data.hasMore === true,
                oldestMessageId: data.oldestMessageId || (data.messages?.length > 0 ? data.messages[data.messages.length - 1].id : null)
            };
        } catch (error) {
            console.error('MessagesModule: Error fetching messages:', error);
            return { success: false, error: error.message };
        }
    }

    async function fetchMessageContext(messageId, bookId) {
        try {
            const response = await window.authFetch(`/api/messages/${messageId}/context?bookId=${bookId}`);
            
            if (!response.ok) {
                return { success: false, error: `HTTP ${response.status}` };
            }
            
            const data = await response.json();
            return {
                success: true,
                messages: data.messages || []
            };
        } catch (error) {
            console.error('MessagesModule: Error fetching context:', error);
            return { success: false, error: error.message };
        }
    }

    async function fetchMedia(messageId) {
        try {
            const response = await window.authFetch(`/api/messages/${messageId}/media`);
            
            if (!response.ok) {
                return { success: false, error: `HTTP ${response.status}` };
            }
            
            const data = await response.json();
            return {
                success: true,
                mediaData: data.media_data,
                mediaType: data.media_type || ''
            };
        } catch (error) {
            console.error('MessagesModule: Error fetching media:', error);
            return { success: false, error: error.message };
        }
    }

    async function updateMessageStatus(messageId, status) {
        try {
            const response = await window.authFetch(`/api/messages/${messageId}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status })
            });
            
            if (!response.ok) {
                const error = await response.json();
                return { success: false, error: error.error || 'Failed to update status' };
            }
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async function searchMessages(query, options = {}) {
        const { limit = 50, page = 1 } = options;
        
        try {
            const response = await window.authFetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}`);
            
            if (!response.ok) {
                return { success: false, error: `HTTP ${response.status}` };
            }
            
            const data = await response.json();
            return {
                success: true,
                results: data.results || [],
                total: data.total || 0
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    function updateMessageCache(bookId, messages, append = false) {
        const cache = _S.getMessageCache();
        if (append && cache[bookId]) {
            cache[bookId] = [...cache[bookId], ...messages];
        } else {
            cache[bookId] = messages;
        }
        _S.setMessageCache(cache);
    }

    function getMessageCache(bookId) {
        const cache = _S.getMessageCache();
        return cache[bookId] || [];
    }

    function clearMessageCache(bookId) {
        const cache = _S.getMessageCache();
        delete cache[bookId];
        _S.setMessageCache(cache);
    }

    window.Nyan = window.Nyan || {};
    window.Nyan.MessagesModule = {
        fetchMessages,
        fetchMessageContext,
        fetchMedia,
        updateMessageStatus,
        searchMessages,
        updateMessageCache,
        getMessageCache,
        clearMessageCache
    };

    console.log('MessagesModule initialized');
})();
