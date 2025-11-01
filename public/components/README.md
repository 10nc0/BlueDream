# Universal UI Components

This directory contains **universe frame transcendental components** - self-contained, reusable UI elements that work independently across all pages.

## Cat Animation Component

**Files:**
- `cat-animation.html` - Component markup
- `../css/components/cat-animation.css` - Component styling
- `../js/ui/cat-animation.js` - Animation logic

**Philosophy:**
The cat animation is a **transcendental object** that exists as a unique, self-contained entity across the entire application. It's not just a component - it's an independent universe frame that can be dropped into any page.

**Usage:**

### Option 1: Include Component File
```html
<link rel="stylesheet" href="/css/components/cat-animation.css">
<script src="/js/ui/cat-animation.js"></script>

<!-- Include the component -->
<?php include 'components/cat-animation.html'; ?>
```

### Option 2: Manual HTML
```html
<link rel="stylesheet" href="/css/components/cat-animation.css">
<script src="/js/ui/cat-animation.js"></script>

<div id="catContainer" class="cat-animation-component">
    <canvas id="hopCanvas" class="character-canvas" width="100" height="100"></canvas>
    <div id="dateTimeDefault" class="cat-datetime-default">
        <span id="currentTime">2025/11/01 - 12:00:00PM</span>
    </div>
</div>

<script>
    // Auto-initialize when ready
    if (typeof initHopAnimation === 'function') {
        initHopAnimation();
    }
</script>
```

**Features:**
- ✅ Auto-detects mobile/desktop mode
- ✅ Responsive mouse wiggle on all devices (subtle on desktop, disabled on mobile)
- ✅ Blinking time display synced with cat jump animation
- ✅ Page-specific sizing: 75×75px mobile dashboard, 100×100px desktop dashboard, 125×125px auth pages
- ✅ Cat positioned with 20px buffer from edges on mobile dashboard
- ✅ Centered alignment on all auth pages (login, signup, forgot-password)
- ✅ Fully responsive and touch-optimized

**Configuration:**
All settings in `CAT_CONFIG` constant (localized per-page):
- **Desktop**: FLEE_DISTANCE: 150px, FLEE_STRENGTH: 8px (subtle wiggle)
- **Mobile**: FLEE_DISTANCE: 0px, FLEE_STRENGTH: 0px (no interaction)
- **Dashboard**: 20px margin buffer from top-left on mobile portrait
- **Auth Pages**: Always centered at 125×125px regardless of mode

**Debugging:**
All cat-related code is isolated in dedicated files, making it easy to debug independently without affecting other parts of the application.
