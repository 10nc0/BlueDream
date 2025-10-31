const authService = require('./auth-service');

/**
 * CRITICAL: Tenant Context Middleware with Proper Connection Isolation
 * 
 * This middleware ensures complete tenant isolation by:
 * 1. Acquiring a DEDICATED client from the pool for each request
 * 2. Using SET LOCAL search_path inside a transaction (connection-scoped)
 * 3. Storing the client in req.dbClient for use by all route handlers
 * 4. Releasing the client only after the response is complete
 * 
 * This prevents the critical bug where pooled connections leak search_path
 * settings between different tenants' requests.
 */
async function setTenantContext(req, res, next) {
    const pool = req.app.locals.pool;
    
    if (!pool) {
        console.error('❌ Pool not available in tenant middleware');
        return res.status(500).json({ error: 'Database connection error' });
    }

    // Acquire a dedicated client from the pool for this request
    const client = await pool.connect();
    
    // CRITICAL: Store client IMMEDIATELY to ensure cleanup always releases it
    req.dbClient = client;
    
    // Track whether transaction was started (for safe cleanup)
    let transactionStarted = false;
    
    // Guard against double-cleanup (MUST be declared before any async work)
    let cleanupCalled = false;
    
    // Attach cleanup EARLY, before any async work or early returns
    const cleanup = async () => {
        if (cleanupCalled) return; // Prevent double-cleanup
        cleanupCalled = true;
        
        // Capture client reference immediately to avoid race conditions
        const dbClient = req.dbClient;
        req.dbClient = null;
        
        if (!dbClient) return; // Already cleaned up
        
        try {
            // Only COMMIT/ROLLBACK if transaction was started
            if (transactionStarted) {
                await dbClient.query('COMMIT');
            }
        } catch (err) {
            console.error('❌ Commit failed:', err.message);
            if (transactionStarted) {
                try {
                    await dbClient.query('ROLLBACK');
                } catch (rollbackErr) {
                    console.error('❌ Rollback failed:', rollbackErr.message);
                }
            }
        } finally {
            // Always release, even if commit/rollback fails
            dbClient.release();
        }
    };
    
    // Attach ONCE to prevent double-firing
    res.once('finish', cleanup);
    res.once('close', cleanup);
    
    try {
        let userId = null;
        let userEmail = null;
        
        // Try JWT token first (wrapped in try/catch to prevent crashes on malformed tokens)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            try {
                const decoded = authService.verifyToken(token);
                if (decoded && decoded.type === 'access') {
                    userId = decoded.userId;
                    userEmail = decoded.email;
                }
            } catch (jwtError) {
                // Invalid token - silently fall back to session
                console.warn('⚠️  Invalid JWT token:', jwtError.message);
            }
        }
        
        // Fall back to session (using optional chaining)
        if (!userId && req.session?.userId) {
            userId = req.session.userId;
            userEmail = req.session.userEmail;
        }
        
        // If no user, continue without tenant context (will be caught by requireAuth)
        if (!userId || !userEmail) {
            req.tenantContext = null;
            // Client will be released by cleanup on 'finish'
            return next();
        }
        
        // Lookup email → tenant mapping
        const mappingResult = await client.query(
            'SELECT tenant_id, tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
            [userEmail]
        );
        
        if (mappingResult.rows.length === 0) {
            if (!res.headersSent) {
                return res.status(401).json({ error: 'User tenant mapping not found' });
            }
            return;
        }
        
        const { tenant_id, tenant_schema } = mappingResult.rows[0];
        
        // Get user's full details from tenant-scoped table
        const userResult = await client.query(
            `SELECT id, email, role, tenant_id, is_genesis_admin 
             FROM ${tenant_schema}.users 
             WHERE id = $1 AND email = $2`,
            [userId, userEmail]
        );
        
        if (userResult.rows.length === 0) {
            // Client will be released by cleanup on 'finish'
            if (!res.headersSent) {
                return res.status(401).json({ error: 'User not found' });
            }
            return;
        }
        
        const user = userResult.rows[0];
        
        // Store tenant context in request (NO tenant_id for non-dev users)
        req.tenantContext = {
            userId: user.id,
            userEmail: user.email,
            userRole: user.role,
            isGenesisAdmin: user.is_genesis_admin
        };
        
        // Begin transaction and set search_path based on role hierarchy
        if (user.role === 'dev') {
            // Dev role: Global access - can query all schemas
            // BUT still need search_path set to their tenant schema for INSERT/UPDATE operations
            await client.query('BEGIN');
            transactionStarted = true; // Mark transaction started for safe cleanup
            await client.query(`SET LOCAL search_path TO ${tenant_schema}, public`);
            req.tenantContext.globalAccess = true;
            // Only dev users get to know about tenant IDs
            req.tenantContext.tenantId = tenant_id;
            req.tenantContext.tenantSchema = tenant_schema;
            console.log(`🔧 Dev user ${user.email} - Global database access (default schema: ${tenant_schema})`);
        } else if (tenant_id && tenant_schema) {
            // Admin/write-only/read-only: Restrict to their tenant schema
            // Start transaction with LOCAL search_path (transaction-scoped)
            await client.query('BEGIN');
            transactionStarted = true; // Mark transaction started for safe cleanup
            await client.query(`SET LOCAL search_path TO ${tenant_schema}, public`);
            req.tenantContext.globalAccess = false;
            // Store tenant_id for SERVER-SIDE use (fractal ID generation, routing)
            // sanitizeForRole() will strip it from API responses to prevent horizontal awareness
            req.tenantContext.tenantId = tenant_id;
            req.tenantContext.tenantSchema = tenant_schema;
            console.log(`🔒 User ${user.email} - Isolated to ${tenant_schema}`);
        } else {
            // User without tenant (shouldn't happen for non-dev users)
            // Client will be released by cleanup on 'finish'
            if (!res.headersSent) {
                return res.status(403).json({ error: 'No tenant assigned to user' });
            }
            return;
        }
        
        next();
    } catch (error) {
        console.error('❌ Tenant middleware error:', error);
        // Do NOT manually release client - cleanup will handle it on 'finish'
        if (!res.headersSent) {
            res.status(500).json({ error: 'Tenant context error' });
        }
    }
}

/**
 * Helper to get all tenant schemas
 * CRITICAL: This MUST only be called by dev users
 * Genesis admins must NEVER access this function
 */
async function getAllTenantSchemas(client, userRole) {
    // Enforce dev-only access
    if (userRole !== 'dev') {
        throw new Error('Access denied: Only dev users can enumerate tenants');
    }
    
    const result = await client.query(`
        SELECT id, tenant_schema, genesis_user_id 
        FROM core.tenant_catalog 
        WHERE status = 'active'
        ORDER BY id
    `);
    return result.rows;
}

/**
 * Sanitize data before sending to non-dev users
 * Recursively removes tenant_id, tenant_schema, raw id, and Nyanbook Ledger webhook from nested objects
 * Forces non-dev users to use opaque fractalized IDs only (IDOR protection)
 */
function sanitizeForRole(data, userRole) {
    if (userRole === 'dev') {
        return data; // Dev sees everything (including raw IDs for debugging)
    }
    
    // Recursive helper to strip sensitive fields
    const strip = (obj) => {
        if (Array.isArray(obj)) {
            return obj.map(strip);
        }
        if (obj && typeof obj === 'object') {
            // Strip sensitive fields:
            // - tenant_id, tenant_schema (horizontal awareness)
            // - id (IDOR protection)
            // - output_01_url (Nyanbook Ledger webhook - cross-tenant security)
            const { tenant_id, tenant_schema, id, output_01_url, ...rest } = obj;
            // Recursively sanitize nested objects
            return Object.fromEntries(
                Object.entries(rest).map(([key, value]) => [key, strip(value)])
            );
        }
        return obj;
    };
    
    return strip(data);
}

module.exports = {
    setTenantContext,
    getAllTenantSchemas,
    sanitizeForRole
};
