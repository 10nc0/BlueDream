# 🌈 Nyan Bridge - WhatsApp to Discord Bridge

A professional multi-platform messaging bridge that connects WhatsApp to Discord (and soon Telegram), with a beautiful glassmorphism UI, multi-user authentication, and permanent message storage.

---

## ⚠️ CRITICAL: Database Isolation for Forked Repls

**If you forked this Repl, you MUST create your own PostgreSQL database!**

### Why This Matters
- Without your own database, you'll use the **developer's database**
- You'll see the developer's messages, users, and data (privacy violation!)
- The developer will see YOUR data too (security risk!)
- **You need your own isolated database**

### How to Fix (Takes 30 seconds)
1. **Click "Tools"** in the left sidebar
2. **Click "PostgreSQL"**  
3. **Wait** for the database to be created (~30 seconds)
4. **Done!** Your `DATABASE_URL` is now set automatically

### Verify It Worked
When you run the app, look for:
```
✅ Database ownership verified - this is YOUR database
```

If you see this instead:
```
⚠️  WARNING: You may be using someone else's database!
```
Go back to step 1 and create your database.

---

## 🚀 Quick Start Guide

### 1. Fork this Repl
Click "Fork" in the top-right corner

### 2. Create Your Database
**Tools → PostgreSQL** (see section above)

### 3. Add Discord Webhook
1. Go to Discord Server Settings → Integrations → Webhooks
2. Create webhook, copy URL
3. **Secrets tab** → Add:
   - Key: `DISCORD_WEBHOOK_URL`
   - Value: `https://discord.com/api/webhooks/YOUR_URL`

### 4. Run the App
Click **Run** and wait for:
```
🌐 Dashboard available at http://localhost:5000
```

### 5. Create Admin Account
1. Go to `/signup.html`
2. Sign up with email + password
3. **You'll be the Genesis User (admin)!**
4. Log in and start using the bridge

---

## 📱 Features

### 🔐 Authentication
- ✅ Email + Password signup/login
- ✅ Google OAuth (optional - requires setup)
- ✅ Multi-user support with roles (admin, read-only, write-only)
- ✅ Session management
- ✅ Genesis user = first user becomes admin

### 🌉 Message Bridging
- ✅ WhatsApp → Discord forwarding
- ✅ Media support (images, videos, documents)
- ✅ Real-time relay
- ✅ **Permanent storage** - messages never deleted
- ✅ Privacy-focused: only messages sent TO bot

### 💎 Dashboard
- ✅ Discord-style message feed
- ✅ Apple glassmorphism design
- ✅ Real-time updates
- ✅ Search with natural language dates
- ✅ Mobile responsive
- ✅ Safari/iPad optimized

### 👤 User Management (Admin)
- ✅ Add/edit users
- ✅ Role-based access control
- ✅ Session monitoring
- ✅ Audit logs
- ✅ Activity tracking

### 🤖 Bot Management
- ✅ Multiple WhatsApp bots
- ✅ QR code linking
- ✅ Connection status
- ✅ 1-to-many forwarding (one bot → multiple Discord webhooks)

---

## 🔑 Required Secrets

### Must Have:
```
DISCORD_WEBHOOK_URL = https://discord.com/api/webhooks/YOUR_WEBHOOK_URL
```

### Optional (For Google OAuth):
```
GOOGLE_CLIENT_ID = your_google_client_id
GOOGLE_CLIENT_SECRET = your_google_client_secret
```
Get these from [Google Cloud Console](https://console.cloud.google.com/)

### Auto-Generated (Don't Modify):
- `DATABASE_URL` - Created when you set up PostgreSQL
- `SESSION_SECRET` - Can customize for extra security

---

## 📖 How to Use

### Connect WhatsApp Bot
1. Log into dashboard
2. Click "Add Bot" 
3. Scan QR code with WhatsApp
4. Configure Discord webhook
5. Bot is live!

### Forward Messages
1. People send messages TO your bot's WhatsApp number
2. Messages appear in Discord automatically
3. All messages logged in dashboard
4. Search, filter, view history

### Manage Users (Admin Only)
1. Settings → Users
2. Add users, assign roles
3. View sessions & audit logs

---

## 🎨 Architecture

### Tech Stack
- **Backend**: Node.js + Express
- **Database**: PostgreSQL (Neon)
- **Auth**: JWT + Passport.js + Google OAuth
- **WhatsApp**: whatsapp-web.js
- **Discord**: Webhooks
- **Frontend**: Vanilla JS + CSS (glassmorphism)

### Database Schema
- `users` - Multi-user authentication
- `bots` - WhatsApp bot configurations
- `messages` - Permanent message storage
- `sessions` - Active user sessions
- `audit_logs` - Security & activity tracking

### Security Features
- ✅ JWT + session cookies (dual auth)
- ✅ bcrypt password hashing
- ✅ Role-based access control
- ✅ Audit logging
- ✅ Safari/iPad cookie compatibility

---

## 🚀 Deployment

### Replit Autoscale (Recommended)
1. Create your database (Tools → PostgreSQL)
2. Set secrets (DISCORD_WEBHOOK_URL)
3. Click **Deploy** → **Autoscale**
4. Configure custom domain (optional)
5. Done!

The app includes:
- Health check endpoints
- Dynamic port binding
- Autoscale-ready configuration

---

## 🐛 Troubleshooting

### "You may be using someone else's database!"
**Solution:** Create your own database  
→ Tools → PostgreSQL → Wait 30 seconds

### "DISCORD_WEBHOOK_URL is required"
**Solution:** Add it in Secrets tab  
→ Get webhook from Discord Server Settings

### WhatsApp won't connect
**Solutions:**
- Make sure QR code is scanned correctly
- WhatsApp Web must be enabled on your phone
- Check browser console for errors

### Can't log in
**Solutions:**
- Sign up first at `/signup.html`
- Check email/password spelling
- Clear browser cache

### Genesis user already exists
**Issue:** Someone already signed up  
**Solution:** This is expected! First user becomes admin. If you forked and see this, you're using the wrong database (see top section).

---

## 📚 Documentation

- `replit.md` - Technical architecture & development notes
- `README.md` - This file (user guide)
- Console logs - Real-time status & debugging

---

## 🔒 Privacy & Data

### Your Data is Private
- ✅ Each forked Repl = isolated database
- ✅ No one can see your messages
- ✅ You control all access
- ✅ Genesis user = YOU

### Message Retention
- ✅ Messages stored permanently (write-only)
- ✅ Cannot be deleted (by design)
- ✅ Full audit trail
- ✅ Search entire history

---

## 🌟 Features in Detail

### Multi-User Authentication
- First user (genesis) becomes admin
- Admin can add more users
- Roles: admin, read-only, write-only
- Google OAuth optional

### Discord-Style Dashboard
- Apple glassmorphism design
- Real-time message updates
- Sidebar with bot list
- Message feed with media
- Search & filters

### 1-to-Many Forwarding
- One WhatsApp bot
- Multiple Discord webhooks
- Route messages anywhere
- Flexible configuration

---

## 💡 Tips

1. **Backup your DATABASE_URL** - Keep it safe in case you need to restore
2. **Use strong passwords** - Especially for admin accounts
3. **Monitor audit logs** - Check for suspicious activity
4. **Add users carefully** - Review roles before assigning
5. **Test webhooks** - Make sure Discord channels are correct

---

## 📄 License

This project is open source. Fork it, customize it, deploy it!

---

## 💬 Need Help?

1. **Check console logs** for detailed error messages
2. **Verify secrets** are set correctly
3. **Ensure database** is created
4. **Review this README** for common issues

**Happy Bridging! 🌉**
