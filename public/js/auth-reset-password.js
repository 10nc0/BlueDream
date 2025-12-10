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

const form = document.getElementById('resetForm');
const errorMessage = document.getElementById('errorMessage');
const successMessage = document.getElementById('successMessage');
const tokenError = document.getElementById('tokenError');

const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token');

if (!token) {
    form.style.display = 'none';
    tokenError.classList.remove('hidden');
}

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

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    
    if (password !== confirmPassword) {
        showError('Passwords do not match');
        return;
    }
    
    if (password.length < 6) {
        showError('Password must be at least 6 characters');
        return;
    }
    
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Updating...';
    
    try {
        const response = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showSuccess('Password updated! Redirecting to login...');
            form.style.display = 'none';
            setTimeout(() => {
                window.location.href = '/login.html';
            }, 2000);
        } else {
            showError(data.error || 'Failed to reset password. Link may have expired.');
        }
    } catch (err) {
        showError('Network error. Please try again.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Set New Password';
    }
});
