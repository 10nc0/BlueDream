let currentPhone = '';

function showError(message) {
    const errorDiv = document.getElementById('error');
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
    document.getElementById('success').classList.add('hidden');
}

function showSuccess(message) {
    const successDiv = document.getElementById('success');
    successDiv.textContent = message;
    successDiv.classList.remove('hidden');
    document.getElementById('error').classList.add('hidden');
}

function hideMessages() {
    document.getElementById('error').classList.add('hidden');
    document.getElementById('success').classList.add('hidden');
}

async function requestReset(e) {
    e.preventDefault();
    hideMessages();
    
    currentPhone = document.getElementById('phone').value;
    
    try {
        const res = await fetch('/api/auth/forgot-password/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: currentPhone })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            showSuccess(`Reset code sent to ${currentPhone}! Check console (dev mode)`);
            console.log('🔐 RESET CODE:', data.devOtp);
            document.getElementById('request-form').classList.remove('active');
            document.getElementById('reset-form').classList.add('active');
        } else {
            showError(data.error || 'Failed to send reset code');
        }
    } catch (error) {
        showError('Network error. Please try again.');
    }
}

async function resetPassword(e) {
    e.preventDefault();
    hideMessages();
    
    const otp = document.getElementById('otp').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    
    if (newPassword !== confirmPassword) {
        showError('Passwords do not match');
        return;
    }

    if (newPassword.length < 8) {
        showError('Password must be at least 8 characters');
        return;
    }
    
    try {
        const res = await fetch('/api/auth/forgot-password/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                phone: currentPhone, 
                otp: otp, 
                newPassword: newPassword 
            })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            showSuccess('Password reset successful! Redirecting to login...');
            setTimeout(() => {
                window.location.href = '/login.html';
            }, 2000);
        } else {
            showError(data.error || 'Failed to reset password');
        }
    } catch (error) {
        showError('Network error. Please try again.');
    }
}

function backToRequest() {
    document.getElementById('reset-form').classList.remove('active');
    document.getElementById('request-form').classList.add('active');
    document.getElementById('otp').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
    hideMessages();
}

document.getElementById('requestForm').addEventListener('submit', requestReset);
document.getElementById('resetForm').addEventListener('submit', resetPassword);
document.getElementById('backToRequestBtn').addEventListener('click', backToRequest);
document.getElementById('backToLoginBtn').addEventListener('click', function() {
    window.location.href = '/login.html';
});

fetch('/api/auth/status')
    .then(res => res.json())
    .then(data => {
        if (data.authenticated) {
            window.location.href = '/';
        }
    });
