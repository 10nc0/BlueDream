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
- ✅ Apple liquid glass design
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

## 🛠️ Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_WEBHOOK_URL` | **Yes** | Discord webhook for message forwarding |
| `DATABASE_URL` | Auto | Created when you set up PostgreSQL |
| `SESSION_SECRET` | Auto | Session encryption key (auto-generated) |

### Deployment Settings

Already configured for **Autoscale** deployment:
- ✅ Health check endpoint: `/health`
- ✅ Dynamic port binding: `process.env.PORT`
- ✅ Auto-restart on crash
- ✅ Scale to zero when idle

---

## 🔒 Security

- ✅ JWT + session cookies (dual auth)
- ✅ bcrypt password hashing
- ✅ Role-based access control
- ✅ Audit logging
- ✅ Safari/iPad compatible cookies
- ✅ Google OAuth optional

---

## 📚 Documentation

- `replit.md` - Technical architecture details
- Console logs - Real-time debugging
- Audit logs - User activity tracking (in dashboard)

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

- Apple-inspired liquid glass UI
- Discord-style message layout
- Responsive mobile design
- Dark mode optimized
- Safari/iPad compatible

---

## 📄 License

This is a deployed SaaS application. Code is yours to modify and deploy.

---

## 💬 Support

Check console logs for detailed error messages and debugging information.

**Happy Bridging! 🌉**
