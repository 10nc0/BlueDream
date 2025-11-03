# 🌈 Nyan Bridge - WhatsApp to Discord Bridge

[![Run on Replit](https://replit.com/badge/github/YOUR_USERNAME/nyan-bridge)](https://replit.com/new/github/YOUR_USERNAME/nyan-bridge)

A professional multi-platform messaging bridge that connects WhatsApp to Discord, with a beautiful glassmorphism UI, multi-user authentication, and permanent message storage.

**Live SaaS Application** - Users sign up and use YOUR deployed instance.

---

## 🚀 One-Click Deploy

**Deploy to Replit in seconds:**
1. Click the "Run on Replit" badge above
2. Wait for setup to complete (~30 seconds)
3. Add your `DISCORD_WEBHOOK_URL` in Secrets
4. Click "Run" to start!

---

## 🚀 What Is This?

Nyan Bridge is a **deployed web application** where:
- ✅ Users visit YOUR website and create accounts
- ✅ First user (you) becomes the admin
- ✅ Additional users can be added with different permission levels
- ✅ Everyone uses the SAME deployed instance
- ✅ All data is stored in ONE central database

**This is NOT a template** - It's a complete SaaS application ready to deploy.

---

## 📋 Quick Start (Developer Setup)

### 1. Set Up Database
1. Click **"Tools"** in the left sidebar
2. Click **"PostgreSQL"**
3. Wait for database creation (~30 seconds)

### 2. Add Required Secrets
In the **Secrets** tab, add:

**Required:**
- `DISCORD_WEBHOOK_URL` - Your Discord webhook for message forwarding
  - Get it from: Discord Server Settings → Integrations → Webhooks

**Optional (for Google OAuth):**
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
  - Get from: [Google Cloud Console](https://console.cloud.google.com/)

### 3. Run the App
Click **"Run"** - The app starts on port 5000

### 4. Create Your Admin Account
1. Visit `/signup.html`
2. Sign up with your email
3. **First user becomes admin automatically!**

---

## 🌐 Deployment (Make It Public)

### Option 1: Deploy from GitHub (Recommended)

1. **Push to GitHub:**
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/nyan-bridge.git
   git branch -M main
   git push -u origin main
   ```

2. **Deploy via Replit Button:**
   - Update the badge URL in README.md with your GitHub username
   - Share your repo - users click "Run on Replit" to deploy their own instance

### Option 2: Deploy to Replit Autoscale

1. **Click "Deploy"** in the top-right
2. **Select "Autoscale"** deployment
3. **Configure domain:**
   - Use default: `your-app.replit.app`
   - Or add custom domain: `yourdomain.com`
4. **Click "Deploy"**

Your app is now live! Users can visit it at your deployment URL.

### What Happens After Deployment?

- ✅ App is available 24/7 at your public URL
- ✅ Users can sign up at `yoursite.com/signup.html`
- ✅ Users log in at `yoursite.com/login.html`
- ✅ Auto-scales to handle traffic
- ✅ Only charged when users are active

---

## 👥 User Management

### User Roles

1. **Admin** (First User)
   - Full access to everything
   - Manage users, bridges, settings
   - View audit logs
   - First signup becomes admin

2. **Read-Only**
   - View messages and bots
   - Cannot make changes
   - Good for observers/clients

3. **Write-Only**
   - Can create/edit bots
   - Cannot view messages
   - Good for bot managers

### Adding Users

**Option 1: Users Sign Up** (Recommended)
1. Share your signup URL: `yoursite.com/signup.html`
2. Users create accounts
3. You (admin) change their role as needed

**Option 2: Admin Creates Users**
1. Log in as admin
2. Go to Settings → Users
3. Add new user manually

---

## 🔐 Authentication Methods

### Email + Password (Always Available)
- Users sign up with email/password
- Secure bcrypt hashing
- JWT tokens for API access

### Google OAuth (Optional)
- Requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- One-click "Continue with Google" login
- Automatically links to existing email accounts

---

## 📱 Features

### Message Bridging
- ✅ WhatsApp → Discord forwarding
- ✅ Media support (images, videos, documents)
- ✅ Real-time relay
- ✅ Permanent storage
- ✅ Privacy-focused (messages sent TO bot only)

### Dashboard
- ✅ Discord-style message feed
- ✅ Apple glassmorphism design
- ✅ Real-time updates
- ✅ Natural language search ("yesterday", "last week")
- ✅ Mobile responsive
- ✅ Safari/iPad optimized

### Admin Panel
- ✅ User management
- ✅ Role assignment
- ✅ Session monitoring
- ✅ Audit logs
- ✅ Bot management

---

## 💰 Monetization (Optional)

Want to charge users for access? Integrate payment processing:

### Stripe Integration
1. Add Stripe to your Replit secrets
2. Create subscription plans
3. Gate features by subscription level

### PayPal Integration
Similar process with PayPal API

**Replit supports both!** Search for integration guides in the Replit docs.

---

## 🛠️ Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_WEBHOOK_URL` | **Yes** | Discord webhook for message forwarding |
| `DATABASE_URL` | Auto | Created when you set up PostgreSQL |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret |
| `SESSION_SECRET` | Auto | Session encryption key (auto-generated) |

### Deployment Settings

Already configured for **Autoscale** deployment:
- ✅ Health check endpoint: `/health`
- ✅ Dynamic port binding: `process.env.PORT`
- ✅ Auto-restart on crash
- ✅ Scale to zero when idle

---

## 📊 Usage Statistics

Track your users:
- Active sessions
- Total users
- Message volume
- Bot uptime

All available in the admin dashboard!

---

## 🔒 Security

- ✅ JWT + session cookies (dual auth)
- ✅ bcrypt password hashing
- ✅ Role-based access control
- ✅ Audit logging
- ✅ Safari/iPad compatible cookies
- ✅ Google OAuth optional

---

## 🐛 Troubleshooting

### "DISCORD_WEBHOOK_URL is required"
**Fix:** Add the webhook URL in the Secrets tab

### WhatsApp won't connect
**Fix:** 
- Scan QR code correctly
- Ensure WhatsApp Web is enabled on your phone

### Users can't sign up
**Fix:**
- Make sure app is deployed (not just running in editor)
- Check signup URL: `yoursite.com/signup.html`

### Forgot admin password
**Fix:**
- Access database directly (Tools → PostgreSQL)
- Reset password or create new admin user

---

## 📚 Documentation

- `replit.md` - Technical architecture details
- Console logs - Real-time debugging
- Audit logs - User activity tracking (in dashboard)

---

## 🎯 Typical Deployment Flow

1. **Developer (You):**
   - Set up database
   - Add Discord webhook secret
   - Run app locally to test
   - Deploy to Autoscale
   - Sign up (become Genesis admin)

2. **End Users:**
   - Visit your deployed URL
   - Click "Sign Up"
   - Create account (email or Google)
   - Start using the bridge!

3. **You (Admin):**
   - Manage users via dashboard
   - Assign roles
   - Monitor activity
   - Add/configure bots

---

## 💎 Tech Stack

- **Backend**: Node.js + Express
- **Database**: PostgreSQL (Supabase)
- **Auth**: JWT + Passport.js + Google OAuth
- **WhatsApp**: whatsapp-web.js
- **Discord**: Webhooks
- **Frontend**: Vanilla JS + Glassmorphism CSS
- **Deployment**: Replit Autoscale

---

## 🎨 Design

- Apple-inspired glassmorphism UI
- Discord-style message layout
- Responsive mobile design
- Dark mode optimized
- Safari/iPad compatible

---

## ✅ Next Steps

1. **Deploy your app** (click "Deploy" → Autoscale)
2. **Get your deployment URL** (e.g., `nyan-bridge.replit.app`)
3. **Sign up as admin** (first user)
4. **Add users** (share signup link)
5. **Start bridging!** (connect WhatsApp → Discord)

**Optional:**
- Add custom domain
- Integrate payment processing
- Customize branding
- Add analytics

---

## 📄 License

This is a deployed SaaS application. Code is yours to modify and deploy.

---

## 💬 Support

Check console logs for detailed error messages and debugging information.

**Happy Bridging! 🌉**
