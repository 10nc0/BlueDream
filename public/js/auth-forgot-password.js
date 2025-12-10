// Cat animation & date/time now auto-initialize via cat-animation.js

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
            showSuccess('You will receive a password reset link via email if email & phone are correct.');
            form.reset();
        } else {
            showError(data.error || 'Something went wrong. Please try again.');
        }
    } catch (err) {
        showError('Network error. Please try again.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Reset Link';
    }
});
