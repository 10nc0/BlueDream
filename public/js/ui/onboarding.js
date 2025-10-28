// Onboarding Wizard System
let onboardingState = {
    step: 1,
    platform: null,
    bridgeId: null,
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
    onboardingState = { step: 1, platform: null, bridgeId: null, webhookUrl: null };
    showOnboardingStep(1);
    document.getElementById('onboardingModal').style.display = 'flex';
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
    document.getElementById(`onboarding-step-${step}`).style.display = 'block';
    
    // Update progress indicator
    updateOnboardingProgress(step);
}

function updateOnboardingProgress(currentStep) {
    const steps = document.querySelectorAll('.onboarding-progress-step');
    steps.forEach((step, index) => {
        const stepNum = index + 1;
        if (stepNum < currentStep) {
            step.classList.add('completed');
            step.classList.remove('active');
        } else if (stepNum === currentStep) {
            step.classList.add('active');
            step.classList.remove('completed');
        } else {
            step.classList.remove('active', 'completed');
        }
    });
}

function selectOnboardingPlatform(platform) {
    onboardingState.platform = platform;
    
    // Highlight selected platform
    document.querySelectorAll('.platform-option').forEach(el => {
        el.classList.remove('selected');
    });
    event.target.closest('.platform-option').classList.add('selected');
    
    // Enable next button
    document.getElementById('step1-next').disabled = false;
}

async function onboardingStep1Next() {
    if (!onboardingState.platform) {
        alert('Please select a platform');
        return;
    }
    
    if (onboardingState.platform === 'WhatsApp') {
        // Create bridge and show QR code
        try {
            const response = await authFetch('/api/bridges', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input_platform: 'WhatsApp',
                    output_platform: 'Discord',
                    webhook_url: 'placeholder' // Will be set in step 3
                })
            });
            
            if (response.ok) {
                const bridge = await response.json();
                onboardingState.bridgeId = bridge.id;
                showOnboardingStep(2);
                
                // Generate QR code
                const qrResponse = await authFetch(`/api/bridges/${bridge.id}/qr`);
                if (qrResponse.ok) {
                    const qrData = await qrResponse.json();
                    document.getElementById('onboarding-qr').src = qrData.qr;
                }
            }
        } catch (error) {
            alert('Failed to create bot: ' + error.message);
        }
    } else {
        // Skip to step 3 for other platforms
        showOnboardingStep(3);
    }
}

function onboardingStep2Next() {
    showOnboardingStep(3);
}

async function validateDiscordWebhook(url) {
    if (!url || !url.includes('discord.com/api/webhooks/')) {
        return { valid: false, error: 'Invalid Discord webhook URL format' };
    }
    
    try {
        // Test webhook with a test message
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: '✅ Nyan Bridge webhook test - connection successful!',
                username: 'Nyan Bridge'
            })
        });
        
        if (response.ok || response.status === 204) {
            return { valid: true };
        } else {
            return { valid: false, error: `Webhook returned status ${response.status}` };
        }
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

async function onboardingStep3Complete() {
    const webhookUrl = document.getElementById('onboarding-webhook-url').value;
    
    if (!webhookUrl) {
        alert('Please enter a Discord webhook URL');
        return;
    }
    
    // Show validation spinner
    document.getElementById('onboarding-validation-status').innerHTML = 
        '<span style="color: #fbbf24;">⏳ Validating webhook...</span>';
    
    const validation = await validateDiscordWebhook(webhookUrl);
    
    if (!validation.valid) {
        const statusEl = document.getElementById('onboarding-validation-status');
        statusEl.textContent = '';
        const span = document.createElement('span');
        span.style.color = '#ef4444';
        span.textContent = `❌ ${validation.error}`;
        statusEl.appendChild(span);
        return;
    }
    
    document.getElementById('onboarding-validation-status').innerHTML = 
        '<span style="color: #22c55e;">✅ Webhook validated!</span>';
    
    // Update bridge with webhook URL
    if (onboardingState.bridgeId) {
        try {
            await authFetch(`/api/bridges/${onboardingState.bridgeId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    webhook_url: webhookUrl
                })
            });
        } catch (error) {
            console.error('Failed to update webhook:', error);
        }
    }
    
    // Mark onboarding as completed
    await saveOnboardingProgress(true);
    
    // Show success and close
    alert('🎉 Onboarding complete! Your bridge is ready.');
    closeOnboardingWizard();
    loadBots(); // Refresh bridge list
}
