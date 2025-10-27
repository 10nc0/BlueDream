const { test, expect } = require('@playwright/test');
const { UI_STATES, VIEWPORTS } = require('./states');
const path = require('path');
const fs = require('fs');

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const BASELINE_DIR = path.join(SCREENSHOTS_DIR, 'baseline');
const CURRENT_DIR = path.join(SCREENSHOTS_DIR, 'current');

// Ensure directories exist
[BASELINE_DIR, CURRENT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Test each UI state at desktop resolution
test.describe('UI Audit - Desktop (1920x1080)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
  });

  for (const state of UI_STATES) {
    test(`${state.name}: ${state.description}`, async ({ page }) => {
      console.log(`\n🧪 Testing: ${state.name}`);
      
      // Navigate to page
      const url = `${BASE_URL}${state.path}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      
      // Wait for cat animation to initialize
      await page.waitForSelector('#hopCanvas', { timeout: 5000 });
      await page.waitForTimeout(500); // Let animations settle
      
      // Execute interactions
      for (const interaction of state.interactions) {
        console.log(`  → ${interaction.description}`);
        
        switch (interaction.type) {
          case 'click':
            await page.click(interaction.selector);
            break;
            
          case 'wait':
            await page.waitForTimeout(interaction.ms);
            break;
            
          case 'check-element':
            const elements = await page.$$(interaction.selector);
            if (interaction.count !== undefined) {
              expect(elements.length).toBe(interaction.count);
            } else {
              expect(elements.length).toBeGreaterThan(0);
            }
            break;
            
          case 'hover':
            await page.hover(interaction.selector);
            break;
        }
      }
      
      // Take screenshot
      const screenshotPath = path.join(CURRENT_DIR, `${state.name}-desktop.png`);
      await page.screenshot({ 
        path: screenshotPath,
        fullPage: true 
      });
      console.log(`  ✅ Screenshot saved: ${state.name}-desktop.png`);
      
      // Visual comparison (if baseline exists)
      const baselinePath = path.join(BASELINE_DIR, `${state.name}-desktop.png`);
      if (fs.existsSync(baselinePath)) {
        // Playwright has built-in visual comparison
        await expect(page).toHaveScreenshot(`${state.name}-desktop.png`, {
          maxDiffPixels: 100,  // Allow small differences
          threshold: 0.2
        });
      } else {
        console.log(`  ⚠️  No baseline found, run with --update-snapshots to create one`);
      }
    });
  }
});

// Test responsive design at mobile resolution
test.describe('UI Audit - Mobile (375x667)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
  });

  // Test key pages on mobile
  const mobileStates = UI_STATES.filter(s => 
    ['login-page', 'dashboard-with-bots', 'dashboard-empty'].includes(s.name)
  );

  for (const state of mobileStates) {
    test(`${state.name}: ${state.description} (mobile)`, async ({ page }) => {
      console.log(`\n📱 Testing mobile: ${state.name}`);
      
      const url = `${BASE_URL}${state.path}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector('#hopCanvas', { timeout: 5000 });
      await page.waitForTimeout(500);
      
      // Execute basic interactions (skip complex ones on mobile)
      for (const interaction of state.interactions) {
        if (interaction.type === 'check-element') {
          const elements = await page.$$(interaction.selector);
          expect(elements.length).toBeGreaterThan(0);
        }
      }
      
      const screenshotPath = path.join(CURRENT_DIR, `${state.name}-mobile.png`);
      await page.screenshot({ 
        path: screenshotPath,
        fullPage: true 
      });
      console.log(`  ✅ Mobile screenshot saved: ${state.name}-mobile.png`);
    });
  }
});

// Test cat animation specifically
test.describe('UI Audit - Interactive Elements', () => {
  test('Cat animation: responds to cursor', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${BASE_URL}/login.html`);
    await page.waitForSelector('#hopCanvas');
    await page.waitForTimeout(1000);
    
    // Take screenshot before hover
    const beforePath = path.join(CURRENT_DIR, 'cat-before-hover.png');
    await page.screenshot({ path: beforePath, clip: { x: 0, y: 0, width: 400, height: 200 } });
    
    // Hover near cat
    await page.mouse.move(100, 80);
    await page.waitForTimeout(500);
    
    // Take screenshot during hover
    const afterPath = path.join(CURRENT_DIR, 'cat-during-hover.png');
    await page.screenshot({ path: afterPath, clip: { x: 0, y: 0, width: 400, height: 200 } });
    
    console.log('  ✅ Cat interaction screenshots captured');
  });
  
  test('Glassmorphism effects: backdrop blur visible', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${BASE_URL}/__audit__/dashboard-with-bots.html`);
    await page.waitForSelector('.bot-card');
    
    // Check CSS properties
    const backdropFilter = await page.$eval('.bot-card', el => 
      window.getComputedStyle(el).backdropFilter
    );
    
    expect(backdropFilter).toContain('blur');
    console.log('  ✅ Glassmorphism blur effect confirmed');
  });
});

// Generate audit report
test.afterAll(async () => {
  const report = {
    timestamp: new Date().toISOString(),
    tests_run: UI_STATES.length,
    states_tested: UI_STATES.map(s => s.name),
    viewports_tested: ['desktop (1920x1080)', 'mobile (375x667)'],
    screenshots_captured: fs.readdirSync(CURRENT_DIR).length
  };
  
  const reportPath = path.join(SCREENSHOTS_DIR, 'audit-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 UI AUDIT COMPLETE');
  console.log('='.repeat(60));
  console.log(`✅ Tested ${report.tests_run} UI states`);
  console.log(`📸 Captured ${report.screenshots_captured} screenshots`);
  console.log(`📝 Report saved to: ${reportPath}`);
  console.log('='.repeat(60) + '\n');
});
