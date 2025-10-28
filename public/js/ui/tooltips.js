// Tooltip Glossary System
let glossary = null;

// Load glossary on page load
async function initTooltips() {
    try {
        const response = await fetch('/data/glossary.json');
        glossary = await response.json();
        console.log('✅ Tooltip glossary loaded');
    } catch (error) {
        console.warn('⚠️ Failed to load glossary, tooltips disabled', error);
        glossary = { tooltips: {}, thresholds: {}, platforms: {} };
    }
}

// Add tooltip to element
function addTooltip(element, tooltipKey) {
    if (!glossary || !glossary.tooltips[tooltipKey]) return;
    
    element.title = glossary.tooltips[tooltipKey];
    element.style.cursor = 'help';
    element.setAttribute('data-tooltip', tooltipKey);
}

// Get status color based on thresholds
function getStatusColor(failedCount) {
    if (!glossary || !glossary.thresholds) return '';
    
    if (failedCount >= glossary.thresholds.failed_critical) {
        return 'status-critical';
    } else if (failedCount >= glossary.thresholds.failed_warning) {
        return 'status-warning';
    }
    return 'status-normal';
}

// Get success badge color
function getSuccessBadgeClass(forwardedCount) {
    if (!glossary || !glossary.thresholds) return 'success';
    
    if (forwardedCount >= glossary.thresholds.success_excellent) {
        return 'success-excellent';
    }
    return 'success';
}

// Initialize on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTooltips);
} else {
    initTooltips();
}
