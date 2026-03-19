async function checkGenesisStatus() {
    try {
        const response = await fetch('/api/auth/check-genesis');
        if (response.ok) {
            const data = await response.json();
            if (data.isFirstUser) {
                document.getElementById('genesisNotice').classList.remove('hidden');
            }
        }
    } catch (error) {
        console.error('Could not check genesis status:', error);
    }
}

async function handleSignup(event) {
    event.preventDefault();

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const submitBtn = event.target.querySelector('button[type="submit"]');

    if (password !== confirmPassword) {
        showError('Passwords do not match');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating Account...';

    try {
        const response = await fetch('/api/auth/signup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (response.ok) {
            if (data.accessToken) {
                localStorage.setItem('accessToken', data.accessToken);
            }
            if (data.refreshToken) {
                localStorage.setItem('refreshToken', data.refreshToken);
            }
            
            showSuccess(data.message || 'Account created! Redirecting...');
            
            setTimeout(() => {
                window.location.href = '/dashboard';
            }, 1500);
        } else {
            console.error('Signup failed:', data);
            showError(data.error || `Signup failed (HTTP ${response.status})`);
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
        }
    } catch (error) {
        console.error('Signup error:', error);
        showError(error.message || 'Network error. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Account';
    }
}

function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    const successDiv = document.getElementById('successMessage');
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
    successDiv.classList.add('hidden');
    
    setTimeout(() => {
        errorDiv.classList.add('hidden');
    }, 5000);
}

function showSuccess(message) {
    const errorDiv = document.getElementById('errorMessage');
    const successDiv = document.getElementById('successMessage');
    successDiv.textContent = message;
    successDiv.classList.remove('hidden');
    errorDiv.classList.add('hidden');
}

document.getElementById('signupForm').addEventListener('submit', handleSignup);

checkGenesisStatus();

fetch('/api/auth/status')
    .then(res => res.json())
    .then(data => {
        if (data.authenticated) {
            window.location.href = '/dashboard';
        }
    });

// Cat animation & date/time now auto-initialize via cat-animation.js
