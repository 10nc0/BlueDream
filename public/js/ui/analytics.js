// Analytics Dashboard System
let analyticsChart = null;
let analyticsData = {};

async function loadAnalyticsDashboard() {
    try {
        // Load analytics data
        const response = await authFetch('/api/analytics/daily?days=30');
        if (response.ok) {
            analyticsData = await response.json();
            renderAnalyticsCharts();
        }
    } catch (error) {
        console.error('Failed to load analytics:', error);
        document.getElementById('analyticsContent').innerHTML = `
            <div style="text-align: center; padding: 3rem; color: #94a3b8;">
                <p>Failed to load analytics data</p>
                <p style="font-size: 0.9rem; margin-top: 0.5rem;">${error.message}</p>
            </div>
        `;
    }
}

function renderAnalyticsCharts() {
    if (!analyticsData.daily || analyticsData.daily.length === 0) {
        document.getElementById('analyticsContent').innerHTML = `
            <div style="text-align: center; padding: 3rem; color: #94a3b8;">
                <p>No analytics data available yet</p>
                <p style="font-size: 0.9rem; margin-top: 0.5rem;">Data will appear after messages are processed</p>
            </div>
        `;
        return;
    }
    
    // Summary Cards
    const totalMessages = analyticsData.summary.total_messages || 0;
    const failedMessages = analyticsData.summary.failed_messages || 0;
    const successRate = totalMessages > 0 
        ? ((totalMessages - failedMessages) / totalMessages * 100).toFixed(1) 
        : 0;
    
    const summaryHTML = `
        <div class="analytics-summary">
            <div class="analytics-card">
                <div class="analytics-card-title">Total Messages</div>
                <div class="analytics-card-value">${totalMessages.toLocaleString()}</div>
            </div>
            <div class="analytics-card">
                <div class="analytics-card-title">Failed Messages</div>
                <div class="analytics-card-value" style="color: #f87171;">${failedMessages.toLocaleString()}</div>
            </div>
            <div class="analytics-card">
                <div class="analytics-card-title">Success Rate</div>
                <div class="analytics-card-value" style="color: #86efac;">${successRate}%</div>
            </div>
            <div class="analytics-card">
                <div class="analytics-card-title">Rate Limit Events</div>
                <div class="analytics-card-value" style="color: #fbbf24;">${analyticsData.summary.rate_limit_events || 0}</div>
            </div>
        </div>
    `;
    
    // Chart Canvas
    const chartHTML = `
        <div class="analytics-chart-container">
            <h3 style="color: #e2e8f0; margin-bottom: 1rem;">Message Volume (Last 30 Days)</h3>
            <canvas id="analyticsChart" width="800" height="300"></canvas>
        </div>
    `;
    
    document.getElementById('analyticsContent').innerHTML = summaryHTML + chartHTML;
    
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
