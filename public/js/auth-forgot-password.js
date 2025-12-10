// Initialize cat animation on page load
document.addEventListener('DOMContentLoaded', () => {
    if (typeof initHopAnimation === 'function') {
        initHopAnimation();
    }
    
    // Update time display
    function updateTime() {
        const now = new Date();
        const formatted = now.toLocaleString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        }).replace(',', ' -');
        
        const timeElement = document.getElementById('currentTime');
        if (timeElement) {
            timeElement.textContent = formatted;
        }
    }
    
    updateTime();
    setInterval(updateTime, 1000);
});

const form = document.getElementById('forgotForm');
const errorMessage = document.getElementById('errorMessage');
const successMessage = document.getElementById('successMessage');

function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.classList.remove('hidden');
    successMessage.classList.add('hidden');
}

function showSuccess(msg) {
    successMessage.textContent = msg;
    successMessage.classList.remove('hidden');
    errorMessage.classList.add('hidden');
}

function standardizePhone(phone) {
    let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
    // Only add +62 default if starts with 0 (Indonesian local format)
    if (cleaned.startsWith('0')) {
        cleaned = '+62' + cleaned.substring(1);
    }
    // Only add + prefix if no + present and starts with digit
    if (!cleaned.startsWith('+') && /^\d/.test(cleaned)) {
        cleaned = '+' + cleaned;
    }
    return cleaned;
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const email = document.getElementById('email').value.trim().toLowerCase();
    const phone = standardizePhone(document.getElementById('phone').value);
    
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';
    
    try {
        const response = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, phone })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showSuccess('Reset link sent to your WhatsApp! Check your messages.');
            form.reset();
        } else {
            showError(data.error || 'Failed to send reset link. Please check your details.');
        }
    } catch (err) {
        showError('Network error. Please try again.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Reset Link';
    }
});
