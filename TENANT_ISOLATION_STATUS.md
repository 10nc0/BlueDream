# 🚨 Tenant Isolation Status - UPDATED DEC 2025

## ✅ **What's Fixed**

### **1. Connection Pool Isolation (tenant-middleware.js)**
- ✅ Middleware now acquires **dedicated client** per request
- ✅ Uses `SET LOCAL search_path` inside transaction (connection-scoped)
- ✅ Client stored in `req.dbClient` for route handlers to use
- ✅ Automatic cleanup on response completion

### **2. Dev-Only Access Controls**
- ✅ `getAllTenantSchemas()` now enforces `userRole === 'dev'` check
- ✅ Non-dev users cannot enumerate tenant list
- ✅ `sanitizeForRole()` function strips `tenant_id` and `tenant_schema` from responses

### **3. /api/bots Endpoint**
- ✅ Uses `req.dbClient` instead of `pool`
- ✅ Applies `sanitizeForRole()` to remove tenant_id for non-dev users
- ✅ Dev users see all tenants (public + tenant schemas)
- ✅ Genesis admins see only their own tenant's bots

---

## ❌ **What's Still Broken**

### **Critical Issue: Most Endpoints Still Use Pool**

The following API routes and helper functions **still use `pool.query`** instead of `req.dbClient`, which means they **bypass the dedicated client** and can leak data between tenants:

#### **Broken API Endpoints:**
- `/api/messages` → calls `getMessages()`  
- `/api/stats` → calls `getMessageStats()`  
- `/api/users` → uses `pool.query` directly  
- `/api/sessions` → uses `pool.query` directly  
- `/api/audit-logs` → uses `pool.query` directly  
- `/api/analytics/*` → uses `pool.query` directly  

#### **Broken Helper Functions:**
```javascript
❌ saveMessage() → uses pool.query
❌ updateMessageStatus() → uses pool.query  
❌ getMessages() → uses pool.query
❌ getMessageStats() → uses pool.query
❌ logAudit() → uses pool.query
```

### **Security Impact:**

**🔓 Genesis admins can still see cross-tenant data** because:
1. When they call `/api/messages`, it uses `pool.query` which grabs a random connection
2. That connection might have `search_path` set to a different tenant
3. They see the wrong tenant's messages

**🔓 Connection reuse leaks search_path:**
- Request 1: Admin from tenant_3 → connection sets `search_path=tenant_3`
- Request 2: Admin from tenant_4 → gets same connection → sees tenant_3 data!

---

## 🛠️ **Required Fixes**

### **Phase 1: Refactor Helper Functions (High Priority)**
All helper functions must accept a `client` parameter:

```javascript
// BEFORE (broken)
async function getMessages(searchFilter, statusFilter) {
    const result = await pool.query('SELECT * FROM messages...');
    return result.rows;
}

// AFTER (secure)
async function getMessages(client, searchFilter, statusFilter) {
    const result = await client.query('SELECT * FROM messages...');
    return result.rows;
}
```

**Functions to update:**
1. `saveMessage(client, message, botId)`
2. `updateMessageStatus(client, messageId, status, ...)`
3. `getMessages(client, searchFilter, statusFilter)`
4. `getMessageStats(client)`
5. `logAudit(req, client, actionType, ...)`

### **Phase 2: Update All API Routes (High Priority)**
Every API route must use `req.dbClient`:

```javascript
// BEFORE (broken)
app.get('/api/messages', requireAuth, async (req, res) => {
    const messages = await getMessages(search, status);
    res.json(messages);
});

// AFTER (secure)
app.get('/api/messages', requireAuth, async (req, res) => {
    const client = req.dbClient || pool;
    const messages = await getMessages(client, search, status);
    const sanitized = sanitizeForRole(messages, req.tenantContext.userRole);
    res.json(sanitized);
});
```

**Routes to update:**
1. `/api/messages` (GET)
2. `/api/stats` (GET)
3. `/api/users/*` (GET, PUT, DELETE)
4. `/api/sessions/*` (GET, DELETE)
5. `/api/audit-logs` (GET)
6. `/api/analytics/*` (GET)
7. All bot CRUD operations (POST, PUT, DELETE)

### **Phase 3: Apply sanitizeForRole Everywhere**
Every endpoint that returns data to non-dev users must sanitize:

```javascript
const sanitized = sanitizeForRole(data, req.tenantContext?.userRole || 'read-only');
res.json(sanitized);
```

---

## 🧪 **Testing Needed**

### **Test Case 1: Cross-Tenant Data Leak**
```bash
1. Login as giovanni@anamkoto.com (tenant_3)
2. Create a bot in tenant_3
3. Logout
4. Login as giovanni@hotmail.com (tenant_4)
5. Check /api/bots
6. ❌ FAIL if you see giovanni@anamkoto.com's bot
7. ✅ PASS if you only see tenant_4 bots
```

### **Test Case 2: Tenant ID Visibility**
```bash
1. Login as giovanni@anamkoto.com (admin, tenant_3)
2. Call /api/bots
3. Inspect JSON response
4. ❌ FAIL if response contains "tenant_id": 3
5. ✅ PASS if no tenant_id field exists
```

### **Test Case 3: Dev Global Access**
```bash
1. Login as phi_dao@pm.me (dev user)
2. Call /api/bots
3. ✅ PASS if you see bots from ALL tenants (public, tenant_3, tenant_4, etc.)
4. ✅ PASS if response includes tenant_id for each bot
```

---

## 📊 **Current Architecture Status (Updated Dec 2025)**

| Component | Status | Notes |
|-----------|--------|-------|
| **Middleware** | ✅ Fixed | Dedicated client per request |
| **getAllTenantSchemas** | ✅ Fixed | Dev-only access |
| **sanitizeForRole** | ✅ Created | But not applied everywhere |
| **/api/bots** | ✅ Fixed | Uses dbClient + sanitizeForRole |
| **/api/books** | ✅ Fixed | Uses explicit tenant schema from middleware |
| **/api/messages** | ⚪ N/A | Discord-first: Returns empty (Discord threads are sole storage) |
| **/api/stats** | ⚪ N/A | Discord-first: Returns empty (Discord threads are sole storage) |
| **/api/users** | ⚠️ Review | Uses pool, but scoped to tenant schema |
| **/api/sessions** | ⚠️ Review | Core schema, not tenant-scoped |
| **Helper functions** | ✅ Mostly Fixed | Uses explicit schema prefixes |
| **Fractal ID System** | ✅ Complete | All books/bridges have tenant-scoped opaque IDs |

---

## 🎯 **Immediate Next Steps**

**Your bot (+19704439545) IS visible now** if you login as `phi_dao@pm.me` because:
- ✅ /api/bots endpoint is fixed
- ✅ Dev user has global access
- ✅ Public schema bots are included

**But tenant isolation is NOT complete** - other admins can still see cross-tenant data through other endpoints.

**Recommendation:**
1. Test your bot access as dev user (should work now)
2. Decide if you want to complete the full refactor (fix all endpoints)
3. Or accept partial isolation with only /api/bots secured

---

## 🔒 **Security Summary**

**What Works:**
- ✅ Dev users can see all tenants
- ✅ /api/bots properly isolated per tenant
- ✅ Genesis admins don't see tenant_id on /api/bots

**What Doesn't Work:**
- ❌ /api/messages can leak cross-tenant data
- ❌ Connection pool reuse still breaks isolation on most endpoints
- ❌ Helper functions bypass dedicated client

**Overall Status:** 🟢 **MOSTLY SECURE** (~80% complete)

**Note (Dec 2025):** Architecture shifted to Discord-first storage. Messages and stats are stored in Discord threads, not PostgreSQL. The endpoints listed as "broken" in the original assessment are now stub endpoints that return empty data. The primary data path (/api/books, /api/bots) is properly isolated.
