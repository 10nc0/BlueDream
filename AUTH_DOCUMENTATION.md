# 🔐 Authentication System - Complete Documentation

**Date**: October 27, 2025  
**Design**: Apple Liquid Glass Theme + Golden Ratio Proportions  
**Framework**: Express.js + PostgreSQL + Bcrypt + Session Management

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Authentication Pages](#authentication-pages)
3. [Design System](#design-system)
4. [API Endpoints](#api-endpoints)
5. [User Flows](#user-flows)
6. [Security Features](#security-features)
7. [Testing Guide](#testing-guide)

---

## 🎯 Overview

The Multi-Platform Bridge features a complete authentication system with:

✅ **4 Authentication Methods:**
1. Email/Password Login
2. Phone OTP Login
3. Public Registration (Email)
4. Password Reset (Phone OTP)

✅ **Security Features:**
- Bcrypt password hashing (10 rounds)
- PostgreSQL session management
- OTP expiration (10 minutes)
- Password validation (min 8 characters)
- Audit trail logging
- IP address tracking

✅ **Design:**
- Apple liquid glass glassmorphism
- Golden ratio proportions (φ ≈ 1.618)
- Responsive mobile layout
- Color-coded pages (Blue/Green/Orange)

---

## 🖼️ Authentication Pages

### 1️⃣ **Login Page** (`/login.html`)

**URL**: `http://localhost:5000/login.html`

**Design Theme**: **Blue** glassmorphism
- Primary: `rgba(59, 130, 246, 0.9)` (Blue)
- Blur: `30px`
- Saturation: `200%`
- Brightness: `1.1`

**Features:**
- ✅ **Two Tabs:**
  - **Email Login** (active by default)
  - **Phone OTP** (sends OTP to phone)
- ✅ **Email Login Fields:**
  - Email input: `admin@bridge.local`
  - Password input
  - Default credentials shown: `admin@bridge.local / admin123`
- ✅ **Phone OTP Fields:**
  - Phone number input with country code
  - OTP input (6 digits)
  - Two-step process: Request OTP → Verify OTP
- ✅ **Navigation Links:**
  - "Forgot password?" → `/forgot-password.html`
  - "Create account" → `/register.html`

**Golden Ratio Elements:**
- Container: `420px` max-width
- Title: `1.618rem` (1.75rem adjusted)
- Subtitle: `1rem` (0.875rem)
- Input padding: `0.618rem × 1rem`
- Button padding: `0.618rem × 1.618rem`
- Gaps: `1rem`, `2rem`

**API Calls:**
- `POST /api/auth/login` - Email/password
- `POST /api/auth/otp/request` - Request OTP
- `POST /api/auth/otp/verify` - Verify OTP

---

### 2️⃣ **Register Page** (`/register.html`)

**URL**: `http://localhost:5000/register.html`

**Design Theme**: **Green** glassmorphism
- Primary: `rgba(34, 197, 94, 0.9)` (Green)
- Blur: `30px`
- Saturation: `200%`
- Brightness: `1.1`

**Features:**
- ✅ **Two Tabs:**
  - **Email Register** (active by default)
  - **Phone Register** (OTP-based)
- ✅ **Email Registration Fields:**
  - Email input
  - Password input (min 8 characters)
  - Confirm password input
  - Password validation (match check)
- ✅ **Phone Registration Fields:**
  - Phone number with country code
  - OTP verification (auto-creates account)
  - Two-step process: Request OTP → Verify & Register
- ✅ **Navigation:**
  - "Back to Login" button
  - "Already have an account? Sign in" link

**Golden Ratio Elements:**
- Container: `535px` max-width (420px × 1.27)
- Title: `1.618rem`
- Subtitle: `1rem`
- Input padding: `0.618rem × 1rem`
- Button padding: `0.618rem × 1.618rem`
- Gaps: `0.618rem`, `1.618rem`

**API Calls:**
- `POST /api/auth/register/public` - Email registration
- `POST /api/auth/otp/request` - Phone OTP (creates user if not exists)
- `POST /api/auth/otp/verify` - Verify & login

**Audit Log Event:**
- Action: `SELF_REGISTER`
- Details: User role, registration method
- Logged without session (pre-login)

---

### 3️⃣ **Forgot Password Page** (`/forgot-password.html`)

**URL**: `http://localhost:5000/forgot-password.html`

**Design Theme**: **Orange** glassmorphism
- Primary: `rgba(251, 146, 60, 0.9)` (Orange)
- Blur: `30px`
- Saturation: `200%`
- Brightness: `1.1`

**Features:**
- ✅ **Two-Step Process:**
  1. **Request Reset Code:**
     - Enter phone number
     - Send reset code via OTP
     - Shows info box: "Enter your phone number to receive a reset code via SMS"
  2. **Reset Password:**
     - Enter OTP code
     - Enter new password (min 8 characters)
     - Confirm new password
     - Validates password match
- ✅ **Navigation:**
  - "Back to Login" button
  - "Don't have an account? Register" link
  - "Back" button (from reset form to request form)

**Golden Ratio Elements:**
- Container: `535px` max-width
- Title: `1.618rem`
- Info box padding: `0.618rem`
- Input padding: `0.618rem × 1rem`
- Button padding: `0.618rem × 1.618rem`
- Gaps: `0.618rem`, `1.618rem`

**API Calls:**
- `POST /api/auth/forgot-password/request` - Send reset code
- `POST /api/auth/forgot-password/reset` - Reset password with OTP

**Audit Log Event:**
- Action: `PASSWORD_RESET`
- Details: Reset method (phone_otp)
- IP address logged

---

## 🎨 Design System

### **Apple Liquid Glass Glassmorphism**

**Core Properties:**
```css
backdrop-filter: blur(30px) saturate(200%) brightness(1.1);
-webkit-backdrop-filter: blur(30px) saturate(200%) brightness(1.1);
background: rgba(30, 41, 59, 0.5);
border: 1px solid rgba(255, 255, 255, 0.2);
box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4), 
            inset 0 1px 0 rgba(255, 255, 255, 0.25);
```

**Blur Levels:**
- Login container: `30px`
- Input fields: `8px`
- Buttons: `8px`
- Tabs: `8px` (inactive), `10px` (active)

**Saturation:**
- Login/Register/Forgot: `200%`
- Buttons: Matches page theme

**Brightness:**
- All containers: `1.1`

### **Color Coding**

**Login (Blue):**
- Active tab: `rgba(59, 130, 246, 0.9)`
- Button: `rgba(59, 130, 246, 0.9)`
- Focus border: `rgba(59, 130, 246, 0.5)`
- Links: `#60a5fa` / `#3b82f6`

**Register (Green):**
- Active tab: `rgba(34, 197, 94, 0.9)`
- Button: `rgba(34, 197, 94, 0.9)`
- Focus border: `rgba(34, 197, 94, 0.5)`

**Forgot Password (Orange):**
- Button: `rgba(251, 146, 60, 0.9)`
- Focus border: `rgba(251, 146, 60, 0.5)`
- Info box: Blue `rgba(59, 130, 246, 0.1)`

**Shared Colors:**
- Error: `rgba(239, 68, 68, 0.1)` background, `#fca5a5` text
- Success: `rgba(34, 197, 94, 0.1)` background, `#86efac` text
- Gray buttons: `rgba(71, 85, 105, 0.8)`

### **Golden Ratio (φ ≈ 1.618)**

**Spacing Scale:**
- XS: `0.618rem` (≈10px)
- S: `1rem` (16px)
- M: `1.618rem` (≈26px)
- L: `2rem` (32px)

**Font Scale:**
- Small: `0.75rem` / `0.875rem`
- Base: `1rem` (16px)
- Large: `1.618rem` (≈26px)

**Padding/Margins:**
- Inputs: `0.618rem × 1rem`
- Buttons: `0.618rem × 1.618rem`
- Containers: `2rem` (mobile: `1.618rem`)
- Form groups: `1.618rem` margin-bottom

**Layout:**
- Login: `420px` max-width
- Register/Forgot: `535px` max-width (420 × 1.27)

### **Responsive Design**

**Mobile Breakpoint:** `< 480px`

**Mobile Adjustments:**
- Body padding: `0.618rem` (from `1.618rem`)
- Container padding: `1.618rem` (from `2rem`)
- Title: `1.25rem` (from `1.618rem`)
- Subtitle: `0.875rem` (from `1rem`)
- Buttons: `0.875rem` font (from `1rem`)

---

## 🔌 API Endpoints

### **Authentication Endpoints**

#### 1. **Email/Password Login**
```
POST /api/auth/login
```

**Request Body:**
```json
{
  "email": "admin@bridge.local",
  "password": "admin123"
}
```

**Response (Success):**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "email": "admin@bridge.local",
    "role": "admin"
  }
}
```

**Response (Error):**
```json
{
  "error": "Invalid credentials"
}
```

**Audit Log:**
- Action: `LOGIN`
- Details: `{ method: "email_password", role: "admin" }`

---

#### 2. **Request OTP (Phone)**
```
POST /api/auth/otp/request
```

**Request Body:**
```json
{
  "phone": "+1234567890"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "OTP sent",
  "devOtp": "123456"
}
```

**Note:** 
- Creates user if doesn't exist (for registration flow)
- OTP expires in 10 minutes
- `devOtp` only in development mode

---

#### 3. **Verify OTP (Phone)**
```
POST /api/auth/otp/verify
```

**Request Body:**
```json
{
  "phone": "+1234567890",
  "otp": "123456"
}
```

**Response (Success):**
```json
{
  "success": true,
  "user": {
    "id": 2,
    "phone": "+1234567890",
    "role": "user"
  }
}
```

**Audit Log:**
- Action: `LOGIN`
- Details: `{ method: "phone_otp", role: "user" }`

---

#### 4. **Public Registration (Email)**
```
POST /api/auth/register/public
```

**Request Body:**
```json
{
  "email": "newuser@example.com",
  "password": "securepassword"
}
```

**Validation:**
- Email required
- Password min 8 characters
- Email must be unique

**Response (Success):**
```json
{
  "success": true,
  "user": {
    "id": 3,
    "email": "newuser@example.com",
    "role": "user"
  }
}
```

**Response (Error):**
```json
{
  "error": "Email already exists"
}
```

**Audit Log:**
- Action: `SELF_REGISTER`
- Actor: New user email
- Details: `{ role: "user" }`

---

#### 5. **Request Password Reset**
```
POST /api/auth/forgot-password/request
```

**Request Body:**
```json
{
  "phone": "+1234567890"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Reset code sent",
  "devOtp": "654321"
}
```

**Response (Error):**
```json
{
  "error": "No account found with this phone number"
}
```

**Note:**
- Requires existing user with phone number
- OTP expires in 10 minutes

---

#### 6. **Reset Password**
```
POST /api/auth/forgot-password/reset
```

**Request Body:**
```json
{
  "phone": "+1234567890",
  "otp": "654321",
  "newPassword": "newsecurepassword"
}
```

**Validation:**
- OTP must be valid and not expired
- Password min 8 characters

**Response (Success):**
```json
{
  "success": true,
  "message": "Password reset successful"
}
```

**Audit Log:**
- Action: `PASSWORD_RESET`
- Actor: User email or phone
- Details: `{ method: "phone_otp" }`

---

#### 7. **Check Auth Status**
```
GET /api/auth/status
```

**Response (Authenticated):**
```json
{
  "authenticated": true,
  "user": {
    "id": 1,
    "email": "admin@bridge.local",
    "phone": null,
    "role": "admin"
  }
}
```

**Response (Not Authenticated):**
```json
{
  "authenticated": false
}
```

---

#### 8. **Logout**
```
POST /api/auth/logout
```

**Response:**
```json
{
  "success": true
}
```

**Audit Log:**
- Action: `LOGOUT`
- Actor: Session user ID

---

## 🔄 User Flows

### **Flow 1: Email/Password Login**

1. User visits `/login.html`
2. "Email Login" tab is active by default
3. User enters email and password
4. Clicks "Sign In"
5. `POST /api/auth/login`
6. On success: Redirects to `/` (dashboard)
7. On error: Shows error message
8. Audit log: `LOGIN` with `email_password` method

---

### **Flow 2: Phone OTP Login**

1. User visits `/login.html`
2. Clicks "Phone OTP" tab
3. Enters phone number with country code
4. Clicks "Send OTP"
5. `POST /api/auth/otp/request`
6. OTP shown in console (dev mode)
7. OTP input field appears
8. User enters OTP and clicks "Verify"
9. `POST /api/auth/otp/verify`
10. On success: Redirects to `/` (dashboard)
11. Audit log: `LOGIN` with `phone_otp` method

**Note:** If phone doesn't exist, user is auto-created with `user` role

---

### **Flow 3: Email Registration**

1. User clicks "Create account" on login page
2. Redirected to `/register.html`
3. "Email Register" tab active by default
4. User enters email, password, confirm password
5. Client validates password match and length
6. Clicks "Create Account"
7. `POST /api/auth/register/public`
8. On success: Shows success message
9. Auto-redirects to `/login.html` after 2 seconds
10. User can now login with new credentials
11. Audit log: `SELF_REGISTER` with new user email

---

### **Flow 4: Phone Registration**

1. User clicks "Create account" on login page
2. Redirected to `/register.html`
3. Clicks "Phone Register" tab
4. Enters phone number
5. Clicks "Send OTP"
6. `POST /api/auth/otp/request` (creates user if not exists)
7. OTP shown in console (dev mode)
8. User enters OTP and clicks "Verify & Register"
9. `POST /api/auth/otp/verify`
10. On success: Auto-logged in and redirected to `/`
11. Audit log: `LOGIN` with `phone_otp` method

---

### **Flow 5: Password Reset**

1. User clicks "Forgot password?" on login page
2. Redirected to `/forgot-password.html`
3. Enters phone number
4. Clicks "Send Reset Code"
5. `POST /api/auth/forgot-password/request`
6. Error if phone not registered
7. OTP shown in console (dev mode)
8. Reset form appears with OTP and password fields
9. User enters OTP, new password, confirm password
10. Client validates password match and length
11. Clicks "Reset Password"
12. `POST /api/auth/forgot-password/reset`
13. On success: Shows success message
14. Auto-redirects to `/login.html` after 2 seconds
15. User can login with new password
16. Audit log: `PASSWORD_RESET` with `phone_otp` method

---

## 🔒 Security Features

### **Password Security**
- ✅ Bcrypt hashing with 10 rounds
- ✅ Minimum 8 characters requirement
- ✅ Password confirmation validation
- ✅ No plain-text storage
- ✅ Hash comparison for login

### **Session Security**
- ✅ PostgreSQL session store (`connect-pg-simple`)
- ✅ HTTP-only session cookies
- ✅ Session expiration
- ✅ Session revocation (admin)
- ✅ IP address tracking

### **OTP Security**
- ✅ 6-digit random code
- ✅ 10-minute expiration
- ✅ One-time use (cleared after verification)
- ✅ Server-side validation
- ✅ Phone number verification

### **Database Security**
- ✅ Parameterized queries (SQL injection prevention)
- ✅ Unique constraints (email, phone)
- ✅ Foreign key constraints
- ✅ Indexes for performance

### **Audit Trail**
- ✅ All auth actions logged
- ✅ IP address recorded
- ✅ Timestamp tracking
- ✅ Actor identification
- ✅ Details in JSONB format

### **Input Validation**
- ✅ Email format validation
- ✅ Password length validation
- ✅ Phone format guidance
- ✅ OTP format (6 digits)
- ✅ Client & server-side validation

---

## 🧪 Testing Guide

### **Manual Testing Checklist**

#### **Login Page:**
- [ ] Email tab active by default
- [ ] Switch to Phone OTP tab works
- [ ] Email login with `admin@bridge.local / admin123` works
- [ ] Phone OTP flow works (request → verify)
- [ ] "Forgot password?" link goes to `/forgot-password.html`
- [ ] "Create account" link goes to `/register.html`
- [ ] Error messages display correctly
- [ ] Success messages display and redirect
- [ ] Already logged in → auto-redirect to dashboard
- [ ] Glassmorphism blur effect visible
- [ ] Mobile responsive (< 480px)

#### **Register Page:**
- [ ] Email tab active by default
- [ ] Switch to Phone Register tab works
- [ ] Email registration creates account
- [ ] Password validation works (8+ chars)
- [ ] Password mismatch shows error
- [ ] Phone OTP registration works
- [ ] "Back to Login" button works
- [ ] "Sign in" link works
- [ ] Success message and redirect to login
- [ ] Duplicate email shows error
- [ ] Green theme applied
- [ ] Glassmorphism visible
- [ ] Mobile responsive

#### **Forgot Password Page:**
- [ ] Phone input displays
- [ ] Send Reset Code works
- [ ] Error if phone not found
- [ ] OTP shown in console (dev mode)
- [ ] Reset form appears after OTP sent
- [ ] Password validation works
- [ ] Password reset successful
- [ ] Redirect to login after reset
- [ ] "Back" button works (form → request)
- [ ] "Back to Login" button works
- [ ] "Register" link works
- [ ] Orange theme applied
- [ ] Glassmorphism visible
- [ ] Mobile responsive

#### **API Testing:**
```bash
# Email login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bridge.local","password":"admin123"}'

# Request OTP
curl -X POST http://localhost:5000/api/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone":"+1234567890"}'

# Verify OTP
curl -X POST http://localhost:5000/api/auth/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"phone":"+1234567890","otp":"123456"}'

# Register
curl -X POST http://localhost:5000/api/auth/register/public \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'

# Request password reset
curl -X POST http://localhost:5000/api/auth/forgot-password/request \
  -H "Content-Type: application/json" \
  -d '{"phone":"+1234567890"}'

# Reset password
curl -X POST http://localhost:5000/api/auth/forgot-password/reset \
  -H "Content-Type: application/json" \
  -d '{"phone":"+1234567890","otp":"654321","newPassword":"newpassword123"}'
```

#### **Audit Trail Verification:**
1. Login with email → Check audit log for `LOGIN` entry
2. Login with OTP → Check audit log for `LOGIN` with `phone_otp`
3. Register new user → Check for `SELF_REGISTER` entry
4. Reset password → Check for `PASSWORD_RESET` entry
5. Verify IP addresses logged
6. Verify timestamps accurate
7. Verify details in JSONB format

---

## 📝 Summary

### **Pages Created:**
1. ✅ `/login.html` - Email + Phone OTP login (Blue theme)
2. ✅ `/register.html` - Email + Phone registration (Green theme)
3. ✅ `/forgot-password.html` - Phone OTP password reset (Orange theme)

### **API Endpoints Created:**
1. ✅ `POST /api/auth/login` - Email/password login
2. ✅ `POST /api/auth/otp/request` - Request OTP
3. ✅ `POST /api/auth/otp/verify` - Verify OTP
4. ✅ `POST /api/auth/register/public` - Public registration
5. ✅ `POST /api/auth/forgot-password/request` - Request reset code
6. ✅ `POST /api/auth/forgot-password/reset` - Reset password
7. ✅ `GET /api/auth/status` - Check auth status
8. ✅ `POST /api/auth/logout` - Logout

### **Features Implemented:**
- ✅ Apple liquid glass glassmorphism on all auth pages
- ✅ Golden ratio proportions throughout
- ✅ Color-coded pages (Blue/Green/Orange)
- ✅ Responsive mobile design
- ✅ OTP-based authentication
- ✅ Password reset flow
- ✅ Public registration
- ✅ Audit trail logging
- ✅ Session management
- ✅ Bcrypt password security
- ✅ Input validation
- ✅ Error handling
- ✅ Success messages
- ✅ Auto-redirects
- ✅ Navigation links

### **Security:**
- ✅ Bcrypt (10 rounds)
- ✅ OTP expiration (10 min)
- ✅ Password min 8 chars
- ✅ SQL injection prevention
- ✅ Session cookies
- ✅ Audit logging
- ✅ IP tracking

---

**All authentication pages and flows are fully functional with Apple liquid glass theme! 🎉**
