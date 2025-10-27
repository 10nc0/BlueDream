# UI Audit System

Automated UI testing and visual regression system for Nyan Bridge.

## 🎯 Purpose

This audit system solves the problem of only being able to screenshot the login page. It systematically tests **ALL UI states** including:
- Login page
- Dashboard (with bots, empty state)
- User management tab
- Sessions tab  
- Bot creation modal
- Message logs
- Responsive layouts (desktop, mobile, tablet)

## 🚀 Quick Start

```bash
# Run full UI audit
npm run audit-ui

# Update baseline screenshots (after intentional UI changes)
npm run audit-ui:update

# View detailed HTML report
npm run audit-ui:report
```

## 📁 Structure

```
tests/ui-audit/
├── fixtures/           # Mock data for each UI state
│   ├── dashboard-with-bots.json
│   ├── dashboard-empty.json
│   └── message-logs.json
├── scripts/
│   └── generate-test-pages.js   # Creates auth-free test pages
├── screenshots/
│   ├── baseline/       # Reference screenshots
│   ├── current/        # Latest test screenshots
│   └── html-report/    # Playwright HTML report
├── states.js           # Registry of all UI test scenarios
└── audit.spec.js       # Playwright test runner
```

## 🧪 How It Works

### 1. **Page Generator**
Creates auth-free test pages from fixtures:
- Reads JSON fixtures with mock data
- Injects data into cloned dashboard HTML
- Mocks API responses (no backend needed)
- Saves to `public/__audit__/` for testing

### 2. **Playwright Test Runner**
Executes comprehensive UI tests:
- Navigates to each test page
- Performs interactions (clicks, hovers, tab switches)
- Validates required elements exist
- Captures screenshots at multiple viewports
- Compares against baseline (visual regression)

### 3. **State Registry**
Single source of truth for all test scenarios:
- Add new states by editing `states.js`
- Define path, fixture, interactions, and validations
- Automatically tested on next audit run

## 📝 Adding New Test States

Edit `tests/ui-audit/states.js`:

```javascript
{
  name: 'my-new-state',
  path: '/__audit__/my-page.html',
  fixture: 'my-data.json',
  description: 'Description of what this tests',
  interactions: [
    { type: 'check-element', selector: '.my-class', description: 'Check element exists' },
    { type: 'click', selector: 'button', description: 'Click button' },
    { type: 'wait', ms: 300 },
    { type: 'check-element', selector: '.result', count: 5 }
  ]
}
```

Create fixture in `tests/ui-audit/fixtures/my-data.json`:

```json
{
  "user": { "email": "test@example.com" },
  "data": [ /* your mock data */ ]
}
```

## 📸 Screenshots

Screenshots are saved in:
- `tests/ui-audit/screenshots/current/` - Latest test run
- `tests/ui-audit/screenshots/baseline/` - Reference images

When you make intentional UI changes:
1. Run `npm run audit-ui:update` to update baselines
2. Review the changes visually
3. Commit new baselines to git

## 🎨 What Gets Tested

- ✅ Cat animation presence and cursor interaction
- ✅ Glassmorphism effects (backdrop blur)
- ✅ All dashboard tabs (Bridges, Users, Sessions)
- ✅ Bot cards and status indicators
- ✅ Create/Edit modals
- ✅ Message logs with media thumbnails
- ✅ Responsive design (desktop, tablet, mobile)
- ✅ Interactive elements (buttons, forms, dropdowns)

## 🔍 Debugging Failed Tests

1. **View HTML report**: `npm run audit-ui:report`
2. **Check screenshots**: Look in `screenshots/current/`
3. **Compare diffs**: Playwright report shows visual diffs
4. **Check console**: Test output shows which elements failed

## 🚦 CI/CD Integration

To run in CI:

```yaml
- name: Install Playwright Browsers
  run: npx playwright install --with-deps chromium

- name: Run UI Audit
  run: npm run audit-ui

- name: Upload Test Results
  uses: actions/upload-artifact@v3
  with:
    name: playwright-report
    path: tests/ui-audit/screenshots/html-report/
```

## 📊 Audit Report

After each run, `screenshots/audit-report.json` contains:
- Timestamp
- Number of tests run
- States tested
- Viewports covered
- Screenshot count

## 🎯 Benefits

1. **No More Login-Only Screenshots**: Tests ALL pages systematically
2. **Visual Regression Detection**: Catches unintended UI changes
3. **Responsive Testing**: Validates mobile/tablet layouts
4. **Fast Iteration**: No manual clicking through UI
5. **Documentation**: Screenshots serve as visual documentation
6. **CI-Ready**: Runs automatically in pipelines

## 🛠️ Maintenance

- **Add states**: Edit `states.js` when adding new pages/features
- **Update fixtures**: Modify JSON files to match your data structure
- **Refresh baselines**: Run with `--update-snapshots` after intentional changes
- **Clean up**: Delete old screenshots periodically to save space
