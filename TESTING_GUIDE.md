# 🧪 Complete UI Testing Guide

## How to View All Pages

Since automated screenshots can't maintain login sessions, here's how to manually verify all UI pages:

---

## Step-by-Step Testing

### 1️⃣ **Login Page** (Already Visible)

**URL**: `http://localhost:5000/login.html`

**What to verify:**
- [ ] Email Login tab (blue, active by default)
- [ ] Phone OTP tab (gray, inactive)
- [ ] Email input: `admin@bridge.local`
- [ ] Password input field
- [ ] "Default admin: admin@bridge.local / admin123" text
- [ ] Blue "Sign In" button with golden ratio padding
- [ ] Glassmorphism blur effect (30px)
- [ ] Responsive mobile layout

**Action**: Login with `admin@bridge.local` / `admin123`

---

### 2️⃣ **Bots Page** (Main Dashboard)

**URL**: `http://localhost:5000/` (after login)

**Header - What to verify:**
- [ ] Logo "🌉 Bridge" (left side, 1.618rem font)
- [ ] Cat animation (center, slate background #475569)
  - [ ] Dark charcoal cat sprite (#1a1a1a)
  - [ ] Golden eyes (#FFD700)
  - [ ] Pink ears/nose (#FF6B9D)
  - [ ] 8 FPS animation (tail swish every 8 frames)
  - [ ] 535px max-width container
  - [ ] 330px canvas width
  - [ ] Green glassmorphism border
- [ ] Green status indicator dot (10px, right side)
- [ ] User email: "admin@bridge.local (admin)"
- [ ] Red "Logout" button (0.618rem × 1.618rem padding)
- [ ] Golden ratio spacing (1.618rem gaps)

**Tabs - What to verify:**
- [ ] "🤖 Bots" tab (blue, active)
- [ ] "👥 Users" tab (gray, visible for admin)
- [ ] 0.618rem gap between tabs
- [ ] 1rem font size

**Bot Library Header:**
- [ ] "Bot Library" title (1.618rem font, bold)
- [ ] Search bar (full-width, glassmorphism)
- [ ] "All Platforms" dropdown
- [ ] Green "+ Create Bot" button

**Sample Bot Card:**
- [ ] "WhatsApp → Discord Bridge" name
- [ ] Platform icons/text
- [ ] Phone number: +19704439545
- [ ] Tag: "Garuda"
- [ ] Stats: 2 msg TOTAL, 2 msg FORWARDED, 0 msg FAILED
- [ ] Green "🔐 QR Login" button
- [ ] Blue "Edit" button
- [ ] Red "Delete" button
- [ ] 0.618rem gap between buttons
- [ ] Glassmorphism background with blur(15px)

**Expanded Bot (click card):**
- [ ] Messages table appears
- [ ] Columns: Timestamp, From, To, Platform, Message, Status
- [ ] Text wrapping in cells (max 300px width)
- [ ] Horizontal scroll on mobile
- [ ] 0.618rem cell padding
- [ ] Search bar above table

**Mobile View (< 768px):**
- [ ] Cat animation hidden
- [ ] Tables swipeable horizontally
- [ ] Touch scrolling works smoothly
- [ ] Buttons have 48px min-height

---

### 3️⃣ **Users Page** (Admin Only)

**Action**: Click "👥 Users" tab

**User Management Section:**
- [ ] "User Management" title (1.618rem)
- [ ] Blue "+ Add User" button
- [ ] User table with columns:
  - Email
  - Phone
  - Role
  - Created
  - Actions
- [ ] Text wrapping (250px max-width per cell)
- [ ] Role badges color-coded:
  - Blue: admin
  - Green: user
  - Gray: viewer
- [ ] "Change Role" dropdown button
- [ ] Red "Delete" button
- [ ] 0.618rem gap between buttons
- [ ] Glassmorphism table container

**Active Sessions Section:**
- [ ] "Active Sessions" title
- [ ] Table columns:
  - User
  - Login Time
  - IP Address
  - Last Active
  - Actions
- [ ] Red "Revoke" button per session
- [ ] Current session highlighted
- [ ] Auto-updates when session revoked

**Audit Trail Section:**
- [ ] "🔍 Audit Trail" title
- [ ] Filter dropdown (All Actions / Logins / User Created / etc)
- [ ] Table columns:
  - Timestamp
  - Actor
  - Action
  - Target
  - Details
  - IP Address
- [ ] Color-coded action badges:
  - 🟢 Green: "Login", "User Created"
  - 🔴 Red: "User Deleted", "Session Revoked"
  - 🟡 Yellow: "Role Changed"
  - ⚪ Gray: "Logout"
- [ ] Text wrapping (300px max-width)
- [ ] Auto-refresh when actions occur
- [ ] Shows up to 50 recent entries

---

## 4️⃣ **Interactive Tests**

### Create New User:
1. Click "+ Add User"
2. Fill in email, phone, password
3. Select role
4. Click "Create"
5. Verify:
   - [ ] User appears in table
   - [ ] Audit log shows "User Created" entry
   - [ ] Entry includes actor, target, role, IP

### Change User Role:
1. Click "Change Role" on a user
2. Select new role
3. Verify:
   - [ ] Role badge updates color
   - [ ] Audit log shows "Role Changed" entry
   - [ ] Details show "admin → user" format

### Revoke Session:
1. Create second login in incognito window
2. Return to admin window
3. Click "Revoke" on the other session
4. Verify:
   - [ ] Session disappears from list
   - [ ] Incognito window logged out
   - [ ] Audit log shows "Session Revoked"
   - [ ] Entry includes IP address

### Delete User:
1. Click "Delete" on a user
2. Confirm deletion
3. Verify:
   - [ ] User removed from table
   - [ ] Audit log shows "User Deleted"
   - [ ] Entry shows actor and target

### Test Table Scrolling:
1. Add many users (or use browser zoom)
2. Verify:
   - [ ] Tables scroll horizontally on mobile
   - [ ] Text wraps properly
   - [ ] Swipe works smoothly
   - [ ] All data visible

---

## 5️⃣ **Golden Ratio Verification**

Use browser DevTools to measure:

**Header:**
- [ ] Logo h1: `1.618rem` (≈ 26px)
- [ ] Header gap: `1.618rem` (≈ 26px)
- [ ] Cat container: `535px` max-width
- [ ] Cat canvas: `330px` width
- [ ] User info gap: `0.618rem` (≈ 10px)
- [ ] Header padding: `0.618rem 1.618rem`

**Tabs:**
- [ ] Tab gap: `0.618rem`
- [ ] Tab padding: `0.618rem 1.618rem`
- [ ] Tab font: `1rem` (16px)
- [ ] Margin-bottom: `1.618rem`

**Buttons:**
- [ ] All buttons: `0.618rem × 1.618rem` padding
- [ ] Border-radius: `0.618rem`
- [ ] Font: `1rem`

**Tables:**
- [ ] Cell padding: `0.618rem`
- [ ] Font: `1rem`

**Library:**
- [ ] Title: `1.618rem`
- [ ] Header gap: `1.618rem`
- [ ] Controls gap: `0.618rem`

**Container:**
- [ ] Main padding: `1.618rem`

---

## 6️⃣ **Glassmorphism Verification**

**Login:**
- [ ] Blur: 30px
- [ ] Saturation: 200%
- [ ] Brightness: 1.1

**Header:**
- [ ] Blur: 20px
- [ ] Saturation: 200%
- [ ] Brightness: 1.1

**Bot Cards:**
- [ ] Blur: 15px
- [ ] Saturation: 180%

**Cat Display:**
- [ ] Blur: 15px
- [ ] Saturation: 200%
- [ ] Brightness: 1.15
- [ ] Glow effect visible

---

## 7️⃣ **Cat Animation Verification**

**What to check:**
- [ ] Cat sprite visible (not ghostly)
- [ ] Dark charcoal color (#1a1a1a) on slate background (#475569)
- [ ] Golden eyes clearly visible
- [ ] Pink ears and nose visible
- [ ] Animation plays at 8 FPS (count frames: 8 ticks = 1 frame)
- [ ] Tail swishes between 2 frames
- [ ] No text overlay below cat
- [ ] Hidden on mobile (< 768px)

---

## 8️⃣ **Audit Log Events to Verify**

Perform these actions and check audit log:

1. **Login**:
   - [ ] Shows "Login" action
   - [ ] Includes auth method (email/otp)
   - [ ] Shows IP address

2. **Logout**:
   - [ ] Shows "Logout" action
   - [ ] Shows actor

3. **Create User**:
   - [ ] Shows "User Created"
   - [ ] Includes role in details

4. **Delete User**:
   - [ ] Shows "User Deleted"
   - [ ] Shows target user

5. **Change Role**:
   - [ ] Shows "Role Changed"
   - [ ] Details show "old_role → new_role"

6. **Revoke Session**:
   - [ ] Shows "Session Revoked"
   - [ ] Includes IP of revoked session

---

## 🎯 Screenshot Checklist

Take screenshots manually of:

1. **Login page** - Email tab
2. **Login page** - Phone OTP tab
3. **Bots page** - Header with cat animation (desktop)
4. **Bots page** - Bot library view
5. **Bots page** - Expanded bot with messages
6. **Users page** - User management table
7. **Users page** - Active sessions
8. **Users page** - Audit trail
9. **Mobile view** - Bots page (< 768px)
10. **Mobile view** - Tables scrolling

---

## 📱 Mobile Testing

**Resize browser to < 768px or use device emulation:**

1. **Header:**
   - [ ] Cat animation hidden
   - [ ] Logo smaller (1rem)
   - [ ] Padding reduced (0.618rem)

2. **Tables:**
   - [ ] Horizontal scroll works
   - [ ] Touch swipe smooth
   - [ ] Min-width 640px maintained
   - [ ] Cells: 0.618rem padding

3. **Buttons:**
   - [ ] 48px min-height
   - [ ] Maintain golden ratio padding
   - [ ] Touch targets adequate

---

## ✅ Complete Feature Checklist

### Authentication:
- [ ] Email login works
- [ ] Password validation
- [ ] Session persistence
- [ ] Auto-redirect to dashboard
- [ ] Logout works
- [ ] Session expiry

### Bot Management:
- [ ] View bot list
- [ ] Search bots
- [ ] Filter by platform
- [ ] Expand/collapse bot cards
- [ ] View message history
- [ ] Create bot (placeholder)
- [ ] Edit bot (placeholder)
- [ ] Delete bot

### User Management (Admin):
- [ ] View users
- [ ] Create user
- [ ] Delete user
- [ ] Change role
- [ ] View active sessions
- [ ] Revoke sessions

### Audit Trail (Admin):
- [ ] View logs
- [ ] Filter by action
- [ ] Color-coded badges
- [ ] Auto-refresh
- [ ] Timestamp display
- [ ] IP tracking

### UI/UX:
- [ ] Golden ratio proportions
- [ ] Glassmorphism effects
- [ ] Text wrapping
- [ ] Mobile responsive
- [ ] Touch scrolling
- [ ] Cat animation
- [ ] Loading states
- [ ] Error messages

---

**Note**: The screenshot tool cannot maintain login sessions, so all authenticated pages must be viewed manually in a browser.
