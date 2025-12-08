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

async function loginWithEmail(e) {
    e.preventDefault();
    hideMessages();
    
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const submitBtn = e.target.querySelector('button[type="submit"]');
    
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing In...';
    
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            if (data.accessToken) {
                localStorage.setItem('accessToken', data.accessToken);
            }
            if (data.refreshToken) {
                localStorage.setItem('refreshToken', data.refreshToken);
            }
            
            showSuccess('Login successful! Redirecting...');
            setTimeout(() => {
                window.location.href = '/dashboard';
            }, 1000);
        } else {
            showError(data.error || 'Login failed');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Sign In';
        }
    } catch (error) {
        showError('Network error. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
    }
}

document.getElementById('loginForm').addEventListener('submit', loginWithEmail);

fetch('/api/auth/status')
    .then(res => res.json())
    .then(data => {
        if (data.authenticated) {
            window.location.href = '/dashboard';
        }
    });

// Initialize cat animation
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
