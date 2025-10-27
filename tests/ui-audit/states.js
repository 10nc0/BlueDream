// UI State Registry - Define all test scenarios here

export const UI_STATES = [
  {
    name: 'login-page',
    path: '/login.html',
    fixture: null,
    description: 'Login page with email/phone OTP options',
    interactions: [
      { type: 'check-element', selector: '#hopCanvas', description: 'Cat animation canvas' },
      { type: 'check-element', selector: 'input[type="text"]', description: 'Email input' },
      { type: 'check-element', selector: 'input[type="password"]', description: 'Password input' },
      { type: 'check-element', selector: 'button[type="submit"]', description: 'Sign In button' }
    ]
  },
  {
    name: 'dashboard-with-bots',
    path: '/__audit__/dashboard-with-bots.html',
    fixture: 'dashboard-with-bots.json',
    description: 'Dashboard showing 3 active bots',
    interactions: [
      { type: 'check-element', selector: '#hopCanvas', description: 'Cat animation canvas' },
      { type: 'check-element', selector: '.bot-card', description: 'Bot cards', count: 3 },
      { type: 'check-element', selector: '.bot-status', description: 'Status badges' },
      { type: 'check-element', selector: '.create-bot-btn', description: 'Create Bridge button' }
    ]
  },
  {
    name: 'dashboard-empty',
    path: '/__audit__/dashboard-empty.html',
    fixture: 'dashboard-empty.json',
    description: 'Dashboard with no bots (empty state)',
    interactions: [
      { type: 'check-element', selector: '#hopCanvas', description: 'Cat animation canvas' },
      { type: 'check-element', selector: '.create-bot-btn', description: 'Create Bridge button' }
    ]
  },
  {
    name: 'dashboard-tabs-users',
    path: '/__audit__/dashboard-with-bots.html',
    fixture: 'dashboard-with-bots.json',
    description: 'Users tab in dashboard',
    interactions: [
      { type: 'click', selector: 'button.tab:nth-child(2)', description: 'Click Users tab' },
      { type: 'wait', ms: 300 },
      { type: 'check-element', selector: '#usersTab', description: 'Users tab content' }
    ]
  },
  {
    name: 'dashboard-tabs-sessions',
    path: '/__audit__/dashboard-with-bots.html',
    fixture: 'dashboard-with-bots.json',
    description: 'Sessions tab in dashboard',
    interactions: [
      { type: 'click', selector: 'button.tab:nth-child(3)', description: 'Click Sessions tab' },
      { type: 'wait', ms: 300 },
      { type: 'check-element', selector: '#sessionsTab', description: 'Sessions tab content' }
    ]
  },
  {
    name: 'bot-modal-create',
    path: '/__audit__/dashboard-with-bots.html',
    fixture: 'dashboard-with-bots.json',
    description: 'Create bot modal',
    interactions: [
      { type: 'click', selector: '.create-bot-btn', description: 'Open create modal' },
      { type: 'wait', ms: 300 },
      { type: 'check-element', selector: '#botModal', description: 'Bot modal' },
      { type: 'check-element', selector: '#modalTitle', description: 'Modal title' },
      { type: 'check-element', selector: '#botPlatform', description: 'Platform select' },
      { type: 'check-element', selector: '#webhooksList', description: 'Webhooks list for 1-to-many' }
    ]
  },
  {
    name: 'message-logs',
    path: '/__audit__/message-logs.html',
    fixture: 'message-logs.json',
    description: 'Message logs table with media attachments',
    interactions: [
      { type: 'check-element', selector: '#hopCanvas', description: 'Cat animation canvas' },
      { type: 'check-element', selector: 'table', description: 'Messages table' },
      { type: 'check-element', selector: '.media-thumbnail', description: 'Media thumbnails', count: 2 }
    ]
  }
];

export const VIEWPORTS = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 667 }
];
