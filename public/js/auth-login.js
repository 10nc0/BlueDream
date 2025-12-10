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

// AI Playground button navigation
const aiPlaygroundBtn = document.getElementById('aiPlaygroundBtn');
if (aiPlaygroundBtn) {
    aiPlaygroundBtn.addEventListener('click', () => {
        window.location.href = '/playground.html';
    });
}

fetch('/api/auth/status')
    .then(res => res.json())
    .then(data => {
        if (data.authenticated) {
            window.location.href = '/dashboard';
        }
    });

// Cat animation & date/time now auto-initialize via cat-animation.js
