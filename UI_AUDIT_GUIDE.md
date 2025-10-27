# 🔍 UI Audit System - Quick Guide

## Breaking the Login Screenshot Loop! ✅

This solves your problem: **No more only screenshotting the login page!**

## 🚀 Usage

```bash
# Run complete UI audit (generates pages + runs all tests)
npm run audit-ui

# Update baseline screenshots after UI changes
npm run audit-ui:update

# View detailed HTML report with screenshots
npm run audit-ui:report
```

## 📸 What Gets Tested

The audit automatically tests ALL these pages:

1. **Login Page** - Email/OTP options, cat animation
2. **Dashboard with Bots** - 3 bot cards, status badges, webhooks
3. **Dashboard Empty** - Empty state view
4. **Users Tab** - User management interface
5. **Sessions Tab** - Active sessions list
6. **Bot Modal** - Create/Edit bridge form with webhook outputs
7. **Message Logs** - Table with media attachments

## 🎯 Features

- ✅ **Auth-free testing**: Bypasses login automatically
- ✅ **Mock data injection**: Uses JSON fixtures instead of real DB
- ✅ **Multiple viewports**: Desktop (1920x1080) + Mobile (375x667)
- ✅ **All states on all viewports**: Every UI state tested on both desktop AND mobile
- ✅ **Visual regression**: Compares screenshots to detect UI changes
- ✅ **Interactive testing**: Clicks tabs, opens modals, hovers elements
- ✅ **Cat animation validation**: Verifies animation is running and canvas updates

## 📊 Output

After running `npm run audit-ui`:

- **Screenshots**: `tests/ui-audit/screenshots/current/` (14+ screenshots per run)
- **Baselines**: `tests/ui-audit/screenshots/baseline/`
- **Report**: `tests/ui-audit/screenshots/audit-report.json`
- **HTML Report**: Run `npm run audit-ui:report` to view
- **Total tests**: 7 states × 2 viewports + interactive tests = 15+ tests per run

## 🎨 Screenshots Generated

For each state:
- `login-page-desktop.png`
- `dashboard-with-bots-desktop.png`
- `dashboard-empty-desktop.png`
- `dashboard-tabs-users-desktop.png`
- `dashboard-tabs-sessions-desktop.png`
- `bot-modal-create-desktop.png`
- `message-logs-desktop.png`
- Mobile versions (375x667)
- Cat interaction screenshots

## 🛠️ Adding New Test Cases

### 1. Create fixture (mock data)

`tests/ui-audit/fixtures/my-new-page.json`:
```json
{
  "user": { "email": "test@example.com" },
  "data": [ /* your mock data */ ]
}
```

### 2. Add to state registry

`tests/ui-audit/states.js`:
```javascript
{
  name: 'my-new-page',
  path: '/__audit__/my-new-page.html',
  fixture: 'my-new-page.json',
  description: 'Description of what this tests',
  interactions: [
    { type: 'check-element', selector: '.my-class' },
    { type: 'click', selector: 'button' },
    { type: 'wait', ms: 300 }
  ]
}
```

### 3. Update page generator (if needed)

`tests/ui-audit/scripts/generate-test-pages.js` - add your page template

### 4. Run audit

```bash
npm run audit-ui
```

## 🔄 Algorithm Override

The audit system runs automatically every time you execute `npm run audit-ui`. It:

1. **Generates** auth-free test pages from fixtures
2. **Starts** the server (if not running)
3. **Navigates** to each page in sequence
4. **Performs** interactions (clicks, hovers, waits)
5. **Validates** required elements exist
6. **Captures** full-page screenshots
7. **Compares** against baselines (if exist)
8. **Reports** results in JSON + HTML format

## 📁 File Structure

```
tests/ui-audit/
├── fixtures/                    # Mock data (JSON)
│   ├── dashboard-with-bots.json
│   ├── dashboard-empty.json
│   └── message-logs.json
├── scripts/
│   └── generate-test-pages.js   # Page generator
├── screenshots/
│   ├── baseline/                # Reference screenshots
│   ├── current/                 # Latest test run
│   └── html-report/             # Playwright report
├── states.js                    # Test scenario registry
├── audit.spec.js                # Playwright test runner
└── README.md                    # Full documentation

public/__audit__/                # Generated test pages
├── dashboard-with-bots.html
├── dashboard-empty.html
└── message-logs.html
```

## 🎯 Benefits

1. **No more login loop**: Tests ALL pages systematically
2. **Fast iteration**: No manual clicking through UI
3. **Visual regression**: Catches unintended changes
4. **Responsive testing**: Mobile + desktop + tablet
5. **Documentation**: Screenshots serve as visual docs
6. **CI-ready**: Runs in automated pipelines

## 🐛 Debugging

If tests fail:
1. Check `tests/ui-audit/screenshots/current/` for latest screenshots
2. Run `npm run audit-ui:report` to see visual diffs
3. Look at console output for element validation failures
4. Verify fixtures have correct data structure

## 🎉 Success!

Now you can audit ALL UI pages with one command instead of only screenshotting the login page! 🚀
