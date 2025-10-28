// Enhanced Search System
let searchFilters = {
    dateFrom: null,
    dateTo: null,
    senderId: null,
    messageType: null,
    status: 'all',
    useRegex: false,
    textQuery: ''
};

function openAdvancedSearch(botId) {
    document.getElementById('advancedSearchModal').style.display = 'flex';
    document.getElementById('advancedSearchBotId').value = botId;
    
    // Reset filters
    searchFilters = {
        dateFrom: null,
        dateTo: null,
        senderId: null,
        messageType: null,
        status: 'all',
        textQuery: ''
    };
    
    renderSearchChips();
}

function closeAdvancedSearch() {
    document.getElementById('advancedSearchModal').style.display = 'none';
}

function addSearchFilter(filterType) {
    const value = document.getElementById(`search-${filterType}`).value;
    if (!value) return;
    
    searchFilters[filterType] = value;
    renderSearchChips();
}

function removeSearchFilter(filterType) {
    searchFilters[filterType] = null;
    renderSearchChips();
}

function renderSearchChips() {
    const container = document.getElementById('searchChips');
    const chips = [];
    
    if (searchFilters.dateFrom) {
        chips.push(`<div class="search-chip">
            From: ${searchFilters.dateFrom}
            <button onclick="removeSearchFilter('dateFrom')">×</button>
        </div>`);
    }
    
    if (searchFilters.dateTo) {
        chips.push(`<div class="search-chip">
            To: ${searchFilters.dateTo}
            <button onclick="removeSearchFilter('dateTo')">×</button>
        </div>`);
    }
    
    if (searchFilters.senderId) {
        chips.push(`<div class="search-chip">
            Sender: ${searchFilters.senderId}
            <button onclick="removeSearchFilter('senderId')">×</button>
        </div>`);
    }
    
    if (searchFilters.messageType && searchFilters.messageType !== 'all') {
        chips.push(`<div class="search-chip">
            Type: ${searchFilters.messageType}
            <button onclick="removeSearchFilter('messageType')">×</button>
        </div>`);
    }
    
    if (searchFilters.status && searchFilters.status !== 'all') {
        chips.push(`<div class="search-chip">
            Status: ${searchFilters.status}
            <button onclick="removeSearchFilter('status')">×</button>
        </div>`);
    }
    
    container.innerHTML = chips.join('');
}

async function executeAdvancedSearch() {
    const botId = document.getElementById('advancedSearchBotId').value;
    const textQuery = document.getElementById('advancedSearchQuery').value;
    
    try {
        const queryParams = new URLSearchParams();
        queryParams.append('botId', botId);
        
        if (textQuery) queryParams.append('q', textQuery);
        if (searchFilters.dateFrom) queryParams.append('dateFrom', searchFilters.dateFrom);
        if (searchFilters.dateTo) queryParams.append('dateTo', searchFilters.dateTo);
        if (searchFilters.senderId) queryParams.append('senderId', searchFilters.senderId);
        if (searchFilters.messageType) queryParams.append('messageType', searchFilters.messageType);
        if (searchFilters.status) queryParams.append('status', searchFilters.status);
        if (searchFilters.useRegex && currentUser?.role === 'admin') {
            queryParams.append('regex', 'true');
        }
        
        const response = await authFetch(`/api/messages/search?${queryParams}`);
        
        if (response.ok) {
            const results = await response.json();
            displaySearchResults(results, botId);
            closeAdvancedSearch();
        } else {
            const error = await response.json();
            alert('Search failed: ' + error.error);
        }
    } catch (error) {
        alert('Search error: ' + error.message);
    }
}

function displaySearchResults(results, botId) {
    // Update message cache with search results
    messageCache[botId] = results;
    
    // Re-render messages
    const messagesContainer = document.getElementById(`discord-messages-${botId}`);
    if (messagesContainer) {
        messagesContainer.innerHTML = renderDiscordMessages(results, botId);
    }
    
    // Show result count
    const resultText = results.length === 1 ? '1 result' : `${results.length} results`;
    showNotification(`🔍 Search complete: ${resultText}`, 'success');
}

function showNotification(message, type = 'info') {
    // Simple notification system
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 1rem 1.5rem;
        background: ${type === 'success' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(59, 130, 246, 0.2)'};
        border: 1px solid ${type === 'success' ? 'rgba(34, 197, 94, 0.4)' : 'rgba(59, 130, 246, 0.4)'};
        color: white;
        border-radius: 8px;
        z-index: 10000;
        animation: slideIn 0.3s ease;
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}
