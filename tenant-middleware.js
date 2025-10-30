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
    
    try {
        let userId = null;
        
        // Try JWT token first
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = authService.verifyToken(token);
            if (decoded && decoded.type === 'access') {
                userId = decoded.userId;
            }
        }
        
        // Fall back to session
        if (!userId && req.session && req.session.userId) {
            userId = req.session.userId;
        }
        
        // If no user, release client and continue (will be caught by requireAuth)
        if (!userId) {
            client.release();
            req.tenantContext = null;
            req.dbClient = null;
            return next();
        }
        
        // Get user's tenant and role
        const userResult = await client.query(`
            SELECT u.id, u.email, u.role, u.tenant_id, u.is_genesis_admin, t.tenant_schema
            FROM users u
            LEFT JOIN core.tenant_catalog t ON u.tenant_id = t.id
            WHERE u.id = $1
        `, [userId]);
        
        if (userResult.rows.length === 0) {
            client.release();
            return res.status(401).json({ error: 'User not found' });
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
            // Start transaction but don't restrict search_path
            await client.query('BEGIN');
            req.tenantContext.globalAccess = true;
            // Only dev users get to know about tenant IDs
            req.tenantContext.tenantId = user.tenant_id;
            req.tenantContext.tenantSchema = user.tenant_schema;
            console.log(`🔧 Dev user ${user.email} - Global database access`);
        } else if (user.tenant_id && user.tenant_schema) {
            // Admin/write-only/read-only: Restrict to their tenant schema
            // Start transaction with LOCAL search_path (transaction-scoped)
            await client.query('BEGIN');
            await client.query(`SET LOCAL search_path TO ${user.tenant_schema}, public`);
            req.tenantContext.globalAccess = false;
            // NEVER expose tenant_id to non-dev users (prevents horizontal awareness)
            req.tenantContext.tenantSchema = user.tenant_schema;
            console.log(`🔒 User ${user.email} - Isolated to ${user.tenant_schema}`);
        } else {
            // User without tenant (shouldn't happen for non-dev users)
            client.release();
            return res.status(403).json({ error: 'No tenant assigned to user' });
        }
        
        // Store the dedicated client in the request object
        req.dbClient = client;
        
        // Guard against double-cleanup
        let cleanupCalled = false;
        
        // Ensure client is released after response completes
        const cleanup = async () => {
            if (cleanupCalled) return; // Prevent double-cleanup
            cleanupCalled = true;
            
            // Capture client reference immediately to avoid race conditions
            const dbClient = req.dbClient;
            req.dbClient = null;
            
            if (!dbClient) return; // Already cleaned up
            
            try {
                await dbClient.query('COMMIT');
                dbClient.release();
            } catch (err) {
                // Only log non-null errors
                if (err && err.message !== 'Cannot read properties of null') {
                    console.error('❌ Error during client cleanup:', err.message);
                }
                try {
                    await dbClient.query('ROLLBACK');
                    dbClient.release();
                } catch (rollbackErr) {
                    // Silently ignore - connection might be dead
                }
            }
        };
        
        // Handle response completion
        res.on('finish', cleanup);
        res.on('close', cleanup);
        
        next();
    } catch (error) {
        console.error('❌ Tenant middleware error:', error);
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error('❌ Rollback error:', rollbackErr);
        }
        client.release();
        res.status(500).json({ error: 'Tenant context error' });
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
 * Removes tenant_id and any cross-tenant awareness
 */
function sanitizeForRole(data, userRole) {
    if (userRole === 'dev') {
        return data; // Dev sees everything
    }
    
    // Strip tenant_id from all objects for non-dev users
    if (Array.isArray(data)) {
        return data.map(item => {
            const { tenant_id, tenant_schema, ...rest } = item;
            return rest;
        });
    } else if (typeof data === 'object' && data !== null) {
        const { tenant_id, tenant_schema, ...rest } = data;
        return rest;
    }
    
    return data;
}

module.exports = {
    setTenantContext,
    getAllTenantSchemas,
    sanitizeForRole
};
