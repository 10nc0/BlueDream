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

function openAdvancedSearch(bridgeId) {
    document.getElementById('advancedSearchModal').style.display = 'flex';
    document.getElementById('advancedSearchBotId').value = bridgeId;
    
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
    container.textContent = ''; // Clear existing chips safely
    
    const createChip = (label, value, filterType) => {
        const chip = document.createElement('div');
        chip.className = 'search-chip';
        
        const text = document.createTextNode(`${label}: ${value}`);
        chip.appendChild(text);
        
        const button = document.createElement('button');
        button.textContent = '×';
        button.onclick = () => removeSearchFilter(filterType);
        chip.appendChild(button);
        
        return chip;
    };
    
    if (searchFilters.dateFrom) {
        container.appendChild(createChip('From', searchFilters.dateFrom, 'dateFrom'));
    }
    
    if (searchFilters.dateTo) {
        container.appendChild(createChip('To', searchFilters.dateTo, 'dateTo'));
    }
    
    if (searchFilters.senderId) {
        container.appendChild(createChip('Sender', searchFilters.senderId, 'senderId'));
    }
    
    if (searchFilters.messageType && searchFilters.messageType !== 'all') {
        container.appendChild(createChip('Type', searchFilters.messageType, 'messageType'));
    }
    
    if (searchFilters.status && searchFilters.status !== 'all') {
        container.appendChild(createChip('Status', searchFilters.status, 'status'));
    }
}

async function executeAdvancedSearch() {
    const bridgeId = document.getElementById('advancedSearchBotId').value;
    const textQuery = document.getElementById('advancedSearchQuery').value;
    
    try {
        const queryParams = new URLSearchParams();
        queryParams.append('bridgeId', bridgeId);
        
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
            displaySearchResults(results, bridgeId);
            closeAdvancedSearch();
        } else {
            const error = await response.json();
            alert('Search failed: ' + error.error);
        }
    } catch (error) {
        alert('Search error: ' + error.message);
    }
}

function displaySearchResults(results, bridgeId) {
    // Update message cache with search results
    messageCache[bridgeId] = results;
    
    // Re-render messages using safe DOM parsing pattern
    const messagesContainer = document.getElementById(`discord-messages-${bridgeId}`);
    if (messagesContainer) {
        const html = renderDiscordMessages(results, bridgeId);
        messagesContainer.replaceChildren();
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        while (tempDiv.firstChild) {
            messagesContainer.appendChild(tempDiv.firstChild);
        }
    }
    
    // Initialize media lazy loading after re-render
    setTimeout(() => {
        if (window.initMediaLazyLoading) {
            window.initMediaLazyLoading();
        }
    }, 100);
    
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
