# 🌈 Nyan Book - Every Record, Forever, Searchable also (#Hash)Tag-enabled.

A notebook app with tags and Regex search (no more folder & filings) with a beautiful glassmorphism UI, multi-user authentication, and permanent message storage.

**Live SaaS Application** - Users sign up and use YOUR deployed instance.

---

## 🔐 Authentication Methods

### Email + Password (Always Available)
- Users sign up with email/password
- Secure bcrypt hashing
- JWT tokens for API access

---

## 📱 Features

### Message & Attachment Recording
- ✅ SNS (via webhook) → SNS (via webhook) forwarding
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
