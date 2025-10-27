// Generate auth-free test pages from fixtures and templates
const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const OUTPUT_DIR = path.join(__dirname, '../../../public/__audit__');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Read the base dashboard HTML
const baseDashboardPath = path.join(__dirname, '../../../public/index.html');
const baseDashboard = fs.readFileSync(baseDashboardPath, 'utf8');

function generateDashboardPage(fixtureName) {
  const fixturePath = path.join(FIXTURES_DIR, fixtureName);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  
  // Inject fixture data into page as inline script
  const injectionScript = `
    <script>
      // Mock data injected for testing
      const AUDIT_FIXTURE = ${JSON.stringify(fixture, null, 2)};
      
      // Override API calls to use fixture data
      const originalFetch = window.fetch;
      window.fetch = function(url, options) {
        if (url.includes('/api/user/me')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(AUDIT_FIXTURE.user)
          });
        }
        if (url.includes('/api/bots')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(AUDIT_FIXTURE.bots || [])
          });
        }
        if (url.includes('/api/users')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([AUDIT_FIXTURE.user])
          });
        }
        if (url.includes('/api/sessions')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([])
          });
        }
        return originalFetch.apply(this, arguments);
      };
      
      // Bypass auth check
      window.checkAuth = async function() {
        return true;
      };
      
      // Add audit banner
      window.addEventListener('DOMContentLoaded', () => {
        const banner = document.createElement('div');
        banner.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; background: rgba(251, 191, 36, 0.9); color: black; text-align: center; padding: 0.5rem; font-weight: 600; z-index: 10000;';
        banner.textContent = '⚠️ AUDIT MODE - Using fixture: ${fixtureName}';
        document.body.prepend(banner);
      });
    </script>
  `;
  
  // Inject before closing </body> tag
  const modifiedDashboard = baseDashboard.replace('</body>', injectionScript + '</body>');
  
  return modifiedDashboard;
}

function generateMessageLogsPage(fixtureName) {
  const fixturePath = path.join(FIXTURES_DIR, fixtureName);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  
  // Create a simple message logs page
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Message Logs - ${fixture.bot.name}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1e3a8a 0%, #312e81 50%, #1e1b4b 100%);
            min-height: 100vh;
            color: white;
        }
        .header {
            background: rgba(255, 255, 255, 0.08);
            backdrop-filter: blur(20px);
            padding: 1.5rem 2rem;
            display: flex;
            align-items: center;
            gap: 1.5rem;
        }
        .animated-character { width: 100px; height: 100px; }
        .character-canvas { width: 100%; height: 100%; image-rendering: pixelated; }
        .logo { font-size: 2rem; font-weight: 700; background: linear-gradient(135deg, #60a5fa, #c084fc, #ec4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
        h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
        table { width: 100%; background: rgba(255, 255, 255, 0.08); backdrop-filter: blur(20px); border-radius: 16px; border-collapse: collapse; overflow: hidden; }
        th, td { padding: 1rem; text-align: left; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
        th { background: rgba(255, 255, 255, 0.05); font-weight: 600; }
        .media-thumbnail { width: 50px; height: 50px; background: rgba(255, 255, 255, 0.1); border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
    </style>
</head>
<body>
    <div class="header">
        <div class="animated-character">
            <canvas id="hopCanvas" class="character-canvas" width="100" height="100"></canvas>
        </div>
        <div class="logo">🌈 Nyan Bridge</div>
    </div>
    
    <div class="container">
        <h1>📨 Message Logs - ${fixture.bot.name}</h1>
        
        <table>
            <thead>
                <tr>
                    <th>Sender</th>
                    <th>Message</th>
                    <th>Media</th>
                    <th>Timestamp</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
                ${fixture.messages.map(msg => `
                    <tr>
                        <td>
                            <div>${msg.sender}</div>
                            <div style="font-size: 0.875rem; opacity: 0.6;">${msg.sender_number}</div>
                        </td>
                        <td>${msg.content}</td>
                        <td>
                            ${msg.has_media ? `<div class="media-thumbnail">📎 ${msg.media_type}</div>` : '-'}
                        </td>
                        <td>${new Date(msg.timestamp).toLocaleString()}</td>
                        <td>${msg.forwarded ? '✅ Forwarded' : '⏳ Pending'}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>
    
    <script>
        // Cat animation
        const canvas = document.getElementById('hopCanvas');
        const ctx = canvas.getContext('2d');
        let frame = 0;
        
        function drawPixelCat(frameNum) {
            ctx.clearRect(0, 0, 100, 100);
            const scale = 2.5;
            const isJump = Math.floor(frameNum / 15) % 2 === 0;
            const yOffset = isJump ? -7.5 : 0;
            
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(35, 55 + yOffset, 30, 20);
            ctx.fillRect(37.5, 37.5 + yOffset, 25, 17.5);
            ctx.fillRect(37.5, 30 + yOffset, 7.5, 7.5);
            ctx.fillRect(55, 30 + yOffset, 7.5, 7.5);
            
            ctx.fillStyle = '#22c55e';
            ctx.fillRect(42.5, 42.5 + yOffset, 5, 5);
            ctx.fillRect(52.5, 42.5 + yOffset, 5, 5);
            
            ctx.fillStyle = '#ec4899';
            ctx.fillRect(47.5, 50 + yOffset, 5, 2.5);
        }
        
        function animate() {
            drawPixelCat(frame);
            frame++;
            requestAnimationFrame(animate);
        }
        animate();
    </script>
</body>
</html>`;
  
  return html;
}

// Generate all test pages
console.log('🎨 Generating UI audit test pages...\n');

const pages = [
  { name: 'dashboard-with-bots.html', generator: () => generateDashboardPage('dashboard-with-bots.json') },
  { name: 'dashboard-empty.html', generator: () => generateDashboardPage('dashboard-empty.json') },
  { name: 'message-logs.html', generator: () => generateMessageLogsPage('message-logs.json') }
];

pages.forEach(page => {
  const outputPath = path.join(OUTPUT_DIR, page.name);
  const content = page.generator();
  fs.writeFileSync(outputPath, content, 'utf8');
  console.log(`✅ Generated: ${page.name}`);
});

console.log(`\n✨ Generated ${pages.length} test pages in public/__audit__/`);
