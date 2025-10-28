// Tooltip Glossary System
let glossary = null;
let tooltipElement = null;
let currentTooltipTarget = null;

// Load glossary on page load
async function initTooltips() {
    try {
        const response = await fetch('/data/glossary.json');
        glossary = await response.json();
        console.log('✅ Tooltip glossary loaded');
        createTooltipElement();
        attachTooltipListeners();
    } catch (error) {
        console.warn('⚠️ Failed to load glossary, tooltips disabled', error);
        glossary = { tooltips: {}, thresholds: {}, platforms: {} };
    }
}

// Create tooltip element
function createTooltipElement() {
    if (tooltipElement) return;
    
    tooltipElement = document.createElement('div');
    tooltipElement.className = 'custom-tooltip';
    document.body.appendChild(tooltipElement);
}

// Attach global tooltip listeners
function attachTooltipListeners() {
    document.addEventListener('mouseover', handleTooltipMouseOver);
    document.addEventListener('mouseout', handleTooltipMouseOut);
}

// Show tooltip on hover
function handleTooltipMouseOver(e) {
    const element = e.target.closest('[data-tooltip]');
    if (!element || !glossary) return;
    
    const tooltipKey = element.getAttribute('data-tooltip');
    const tooltipText = glossary.tooltips[tooltipKey];
    if (!tooltipText) return;
    
    currentTooltipTarget = element;
    showTooltip(element, tooltipText);
}

// Hide tooltip on mouse out
function handleTooltipMouseOut(e) {
    const element = e.target.closest('[data-tooltip]');
    if (element === currentTooltipTarget) {
        hideTooltip();
        currentTooltipTarget = null;
    }
}

// Position and show tooltip
function showTooltip(element, text) {
    if (!tooltipElement) return;
    
    tooltipElement.textContent = text;
    
    const rect = element.getBoundingClientRect();
    const tooltipHeight = 100; // Approximate height
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    
    // Position tooltip
    let top, left;
    
    // Decide if tooltip should be above or below
    if (spaceBelow < tooltipHeight && spaceAbove > spaceBelow) {
        // Show above
        tooltipElement.classList.add('arrow-bottom');
        tooltipElement.classList.remove('arrow-top');
        top = rect.top - 10; // 10px offset
        tooltipElement.style.transform = 'translateY(-100%)';
    } else {
        // Show below
        tooltipElement.classList.add('arrow-top');
        tooltipElement.classList.remove('arrow-bottom');
        top = rect.bottom + 10;
        tooltipElement.style.transform = 'translateY(0)';
    }
    
    left = rect.left + (rect.width / 2);
    
    tooltipElement.style.top = `${top}px`;
    tooltipElement.style.left = `${left}px`;
    tooltipElement.style.transform += ' translateX(-50%)';
    
    // Show tooltip
    setTimeout(() => {
        tooltipElement.classList.add('show');
    }, 50);
}

// Hide tooltip
function hideTooltip() {
    if (!tooltipElement) return;
    tooltipElement.classList.remove('show');
}

// Add tooltip to element (legacy support)
function addTooltip(element, tooltipKey) {
    if (!glossary || !glossary.tooltips[tooltipKey]) return;
    
    element.style.cursor = 'help';
    element.setAttribute('data-tooltip', tooltipKey);
    // Don't set title to avoid native tooltip
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
