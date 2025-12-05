// Onboarding Wizard System - Twilio Join Code Flow
let onboardingState = {
    step: 1,
    platform: 'WhatsApp',
    bookId: null,
    bookName: null,
    joinCode: null,
    webhookUrl: null
};

async function checkOnboardingStatus() {
    try {
        const response = await authFetch('/api/onboarding/status');
        if (response.ok) {
            const data = await response.json();
            return data.completed;
        }
    } catch (error) {
        console.warn('Could not check onboarding status:', error);
    }
    return false;
}

async function saveOnboardingProgress(completed = false) {
    try {
        await authFetch('/api/onboarding/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed, state: onboardingState })
        });
    } catch (error) {
        console.error('Failed to save onboarding progress:', error);
    }
}

function openOnboardingWizard() {
    onboardingState = { step: 1, platform: 'WhatsApp', bookId: null, bookName: null, joinCode: null, webhookUrl: null };
    showOnboardingStep(1);
    document.getElementById('onboardingModal').style.display = 'flex';
    
    // Focus on book name input
    setTimeout(() => {
        const nameInput = document.getElementById('onboarding-book-name');
        if (nameInput) nameInput.focus();
    }, 100);
}

function closeOnboardingWizard() {
    document.getElementById('onboardingModal').style.display = 'none';
}

function showOnboardingStep(step) {
    onboardingState.step = step;
    
    // Hide all steps
    document.querySelectorAll('.onboarding-step').forEach(el => {
        el.style.display = 'none';
    });
    
    // Show current step
    const stepEl = document.getElementById(`onboarding-step-${step}`);
    if (stepEl) stepEl.style.display = 'block';
    
    // Update progress indicator
    updateOnboardingProgress(step);
}

function updateOnboardingProgress(currentStep) {
    const steps = document.querySelectorAll('.onboarding-progress-step');
    steps.forEach((step, index) => {
        const stepNum = index + 1;
        if (stepNum < currentStep) {
            step.style.background = 'rgba(34, 197, 94, 0.2)';
            step.style.borderColor = 'rgba(34, 197, 94, 0.3)';
            step.style.color = '#22c55e';
        } else if (stepNum === currentStep) {
            step.style.background = 'rgba(59, 130, 246, 0.2)';
            step.style.borderColor = 'rgba(59, 130, 246, 0.3)';
            step.style.color = '#93c5fd';
        } else {
            step.style.background = 'rgba(148, 163, 184, 0.1)';
            step.style.borderColor = 'rgba(148, 163, 184, 0.2)';
            step.style.color = '#94a3b8';
        }
    });
}

function selectOnboardingPlatform(platform) {
    if (platform === 'Telegram') return; // Coming soon
    
    onboardingState.platform = platform;
    
    // Highlight selected platform
    document.querySelectorAll('.platform-option').forEach(el => {
        const elPlatform = el.dataset.platform || el.textContent.trim();
        if (elPlatform.includes(platform)) {
            el.classList.add('selected');
            el.style.background = 'rgba(37, 99, 235, 0.2)';
            el.style.borderColor = 'rgba(59, 130, 246, 0.5)';
        } else {
            el.classList.remove('selected');
            el.style.background = 'rgba(148, 163, 184, 0.05)';
            el.style.borderColor = 'rgba(148, 163, 184, 0.2)';
        }
    });
}

async function onboardingStep1Next() {
    const bookName = document.getElementById('onboarding-book-name').value.trim();
    const webhookUrl = document.getElementById('onboarding-webhook-url').value.trim();
    
    if (!bookName) {
        alert('Please enter a name for your book');
        document.getElementById('onboarding-book-name').focus();
        return;
    }
    
    onboardingState.bookName = bookName;
    onboardingState.webhookUrl = webhookUrl;
    
    // Show loading state
    const btn = document.getElementById('step1-next');
    const originalText = btn.textContent;
    btn.textContent = '⏳ Creating...';
    btn.disabled = true;
    
    try {
        // Create the book
        const response = await authFetch('/api/books', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: bookName,
                input_platform: 'whatsapp',
                output_platform: 'discord',
                webhook_url: webhookUrl || null
            })
        });
        
        if (response.ok) {
            const book = await response.json();
            onboardingState.bookId = book.fractal_id || book.id;
            onboardingState.joinCode = book.contact_info || book.join_code;
            
            // Show step 2 with join code
            showOnboardingStep(2);
            displayJoinCode(onboardingState.joinCode);
        } else {
            const error = await response.json();
            alert('Failed to create book: ' + (error.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error creating book:', error);
        alert('Failed to create book: ' + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

function displayJoinCode(joinCode) {
    const code = joinCode || 'join code-here';
    const whatsappNumber = '14155238886'; // Twilio sandbox number
    const whatsappLink = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(code)}`;
    
    // Update join code display
    document.getElementById('onboarding-join-code').textContent = code;
    
    // Update WhatsApp link
    const linkEl = document.getElementById('onboarding-whatsapp-link');
    if (linkEl) linkEl.href = whatsappLink;
    
    // Setup copy button
    const copyBtn = document.getElementById('onboarding-copy-code');
    if (copyBtn) {
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(code);
            copyBtn.textContent = '✅ Copied!';
            setTimeout(() => {
                copyBtn.textContent = '📋 Copy Code';
            }, 1500);
        };
    }
}

async function onboardingComplete() {
    // Mark onboarding as completed
    await saveOnboardingProgress(true);
    
    // Close modal and refresh book list
    closeOnboardingWizard();
    
    // Refresh the book list to show the new book
    if (typeof loadBots === 'function') {
        loadBots();
    }
    
    // Show success toast if available
    if (typeof showToast === 'function') {
        showToast('🎉 Book created! Send the join code via WhatsApp to activate.', 'success');
    }
}

// Initialize onboarding event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Step 1 next button
    const step1NextBtn = document.getElementById('step1-next');
    if (step1NextBtn) {
        step1NextBtn.addEventListener('click', onboardingStep1Next);
    }
    
    // Done button
    const doneBtn = document.getElementById('onboarding-done');
    if (doneBtn) {
        doneBtn.addEventListener('click', onboardingComplete);
    }
    
    // Platform selection
    document.querySelectorAll('.platform-option').forEach(el => {
        if (!el.style.cursor || el.style.cursor !== 'not-allowed') {
            el.addEventListener('click', (e) => {
                const platform = el.dataset.platform || 'WhatsApp';
                selectOnboardingPlatform(platform);
            });
        }
    });
    
    // Close button
    const closeBtn = document.querySelector('#onboardingModal .close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeOnboardingWizard);
    }
    
    // Enter key on book name input
    const nameInput = document.getElementById('onboarding-book-name');
    if (nameInput) {
        nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                onboardingStep1Next();
            }
        });
    }
});
