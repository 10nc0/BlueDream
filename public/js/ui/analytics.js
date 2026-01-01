// Analytics Dashboard System
let analyticsChart = null;
let analyticsData = {};
let analyticsBooks = [];

// Populate book filter dropdown
async function populateAnalyticsBookFilter() {
    try {
        const response = await authFetch('/api/books');
        if (response.ok) {
            analyticsBooks = await response.json();
            const select = document.getElementById('analyticsBookFilter');
            
            // Clear and rebuild options
            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = 'All Books';
            select.replaceChildren(defaultOption);
            
            analyticsBooks.forEach(book => {
                const option = document.createElement('option');
                option.value = book.id;
                option.textContent = `${book.name || book.input_platform + ' → ' + book.output_platform}`;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Failed to load books for analytics filter:', error);
    }
}

async function loadAnalyticsDashboard() {
    // Populate book filter on first load
    if (analyticsBooks.length === 0) {
        await populateAnalyticsBookFilter();
    }
    
    try {
        // Get filter values
        const bookId = document.getElementById('analyticsBookFilter')?.value || '';
        const days = document.getElementById('analyticsTimeRange')?.value || '30';
        
        // Build query string
        const params = new URLSearchParams({ days });
        if (bookId) {
            params.append('book_id', bookId);
        }
        
        // Load analytics data
        const response = await authFetch(`/api/analytics/daily?${params}`);
        if (response.ok) {
            analyticsData = await response.json();
            renderAnalyticsCharts();
        }
    } catch (error) {
        console.error('Failed to load analytics:', error);
        const container = document.getElementById('analyticsContent');
        container.replaceChildren();
        
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'text-align: center; padding: 3rem; color: #94a3b8;';
        
        const mainMessage = document.createElement('p');
        mainMessage.textContent = 'Failed to load analytics data';
        
        const errorMessage = document.createElement('p');
        errorMessage.style.cssText = 'font-size: 0.9rem; margin-top: 0.5rem;';
        errorMessage.textContent = error.message;
        
        wrapper.appendChild(mainMessage);
        wrapper.appendChild(errorMessage);
        container.appendChild(wrapper);
    }
}

function renderAnalyticsCharts() {
    const container = document.getElementById('analyticsContent');
    container.textContent = ''; // Clear existing content safely
    
    if (!analyticsData.daily || analyticsData.daily.length === 0) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'text-align: center; padding: 3rem; color: #94a3b8;';
        
        const mainMessage = document.createElement('p');
        mainMessage.textContent = 'No analytics data available yet';
        
        const subMessage = document.createElement('p');
        subMessage.style.cssText = 'font-size: 0.9rem; margin-top: 0.5rem;';
        subMessage.textContent = 'Data will appear after messages are processed';
        
        wrapper.appendChild(mainMessage);
        wrapper.appendChild(subMessage);
        container.appendChild(wrapper);
        return;
    }
    
    // Show book filter info if filtering
    if (analyticsData.book) {
        const bookInfo = document.createElement('div');
        bookInfo.style.cssText = 'background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 1.5rem; color: #60a5fa; font-size: 0.875rem;';
        
        bookInfo.replaceChildren();
        bookInfo.appendChild(document.createTextNode('📊 Showing analytics for: '));
        const strong = document.createElement('strong');
        strong.textContent = analyticsData.book.name || `${analyticsData.book.input_platform} → ${analyticsData.book.output_platform}`;
        bookInfo.appendChild(strong);
        
        container.appendChild(bookInfo);
    }
    
    // Summary Cards
    const totalMessages = analyticsData.summary.total_messages || 0;
    const failedMessages = analyticsData.summary.failed_messages || 0;
    const successRate = totalMessages > 0 
        ? ((totalMessages - failedMessages) / totalMessages * 100).toFixed(1) 
        : 0;
    
    // Create summary section using safe DOM methods
    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'analytics-summary';
    
    // Helper function to create analytics cards
    function createCard(title, value, color = null) {
        const card = document.createElement('div');
        card.className = 'analytics-card';
        
        const cardTitle = document.createElement('div');
        cardTitle.className = 'analytics-card-title';
        cardTitle.textContent = title;
        
        const cardValue = document.createElement('div');
        cardValue.className = 'analytics-card-value';
        cardValue.textContent = value;
        if (color) cardValue.style.color = color;
        
        card.appendChild(cardTitle);
        card.appendChild(cardValue);
        return card;
    }
    
    summaryDiv.appendChild(createCard('Total Messages', totalMessages.toLocaleString()));
    summaryDiv.appendChild(createCard('Failed Messages', failedMessages.toLocaleString(), '#f87171'));
    summaryDiv.appendChild(createCard('Success Rate', `${successRate}%`, '#86efac'));
    summaryDiv.appendChild(createCard('Rate Limit Events', String(analyticsData.summary.rate_limit_events || 0), '#fbbf24'));
    
    // Create chart container using safe DOM methods
    const chartContainer = document.createElement('div');
    chartContainer.className = 'analytics-chart-container';
    
    const chartTitle = document.createElement('h3');
    chartTitle.style.cssText = 'color: #e2e8f0; margin-bottom: 1rem;';
    chartTitle.textContent = 'Message Volume (Last 30 Days)';
    
    const canvas = document.createElement('canvas');
    canvas.id = 'analyticsChart';
    canvas.width = 800;
    canvas.height = 300;
    
    chartContainer.appendChild(chartTitle);
    chartContainer.appendChild(canvas);
    
    // Append to container
    container.appendChild(summaryDiv);
    container.appendChild(chartContainer);
    
    // Render Chart with Chart.js
    renderVolumeChart();
}

function renderVolumeChart() {
    const ctx = document.getElementById('analyticsChart');
    if (!ctx) return;
    
    // Destroy existing chart if any
    if (analyticsChart) {
        analyticsChart.destroy();
    }
    
    const labels = analyticsData.daily.map(d => {
        const date = new Date(d.date);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    
    const totalData = analyticsData.daily.map(d => d.total_messages || 0);
    const failedData = analyticsData.daily.map(d => d.failed_messages || 0);
    
    analyticsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Total Messages',
                    data: totalData,
                    borderColor: 'rgba(59, 130, 246, 1)',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4
                },
                {
                    label: 'Failed Messages',
                    data: failedData,
                    borderColor: 'rgba(239, 68, 68, 1)',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    labels: {
                        color: '#e2e8f0',
                        font: { size: 12 }
                    }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#e2e8f0',
                    bodyColor: '#cbd5e1',
                    borderColor: 'rgba(59, 130, 246, 0.3)',
                    borderWidth: 1
                }
            },
            scales: {
                x: {
                    ticks: { color: '#94a3b8', font: { size: 11 } },
                    grid: { color: 'rgba(148, 163, 184, 0.1)' }
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: '#94a3b8', font: { size: 11 } },
                    grid: { color: 'rgba(148, 163, 184, 0.1)' }
                }
            }
        }
    });
}

// Load analytics when tab is opened
function switchToAnalyticsTab() {
    switchTab('analytics');
    loadAnalyticsDashboard();
}
