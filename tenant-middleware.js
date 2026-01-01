const authService = require('./auth-service');

/**
 * CRITICAL: Tenant Context Middleware for Transaction Mode
 * 
 * This middleware ensures complete tenant isolation by:
 * 1. Acquiring a SHORT-LIVED client to fetch tenant context
 * 2. Storing tenant context (tenantSchema) in req.tenantContext
 * 3. Releasing the client immediately (no holding for entire request)
 * 4. Route handlers use pool.query() with explicit ${tenantSchema}.table_name prefixes
 * 
 * TRANSACTION MODE: We do NOT use SET search_path (not supported in pool_mode=transaction)
 * All routes must use explicit ${tenantSchema}.table_name prefixes for isolation
 * This allows scaling to 10,000+ concurrent connections vs 3-10 in Session mode
 * 
 * ARCHITECTURE: No client is held for the request lifecycle to prevent pool exhaustion.
 * Under concurrent load, holding clients blocked downstream queries from acquiring new ones.
 */
async function setTenantContext(req, res, next) {
    const pool = req.app.locals.pool;
    
    if (!pool) {
        console.error('❌ Pool not available in tenant middleware');
        return res.status(500).json({ error: 'Database connection error' });
    }

    // Acquire client temporarily, release immediately after fetching context
    const client = await pool.connect();
    
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
            client.release();
            req.tenantContext = null;
            return next();
        }
        
        // Look up email → tenant mapping
        const mappingResult = await client.query(
            'SELECT tenant_id, tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
            [userEmail]
        );
        
        if (mappingResult.rows.length === 0) {
            client.release();
            if (!res.headersSent) {
                return res.status(401).json({ error: 'User tenant mapping not found' });
            }
            return;
        }
        
        const { tenant_id, tenant_schema } = mappingResult.rows[0];
        
        // Validate tenant_schema is a safe PostgreSQL identifier (defense-in-depth)
        if (!tenant_schema || !/^[a-z_][a-z0-9_]*$/i.test(tenant_schema)) {
            client.release();
            console.error('❌ Invalid tenant_schema format:', tenant_schema);
            return res.status(500).json({ error: 'Invalid tenant configuration' });
        }
        
        // Get user's full details from tenant-scoped table
        const userResult = await client.query(
            `SELECT id, email, role, tenant_id, is_genesis_admin 
             FROM ${tenant_schema}.users 
             WHERE id = $1 AND email = $2`,
            [userId, userEmail]
        );
        
        if (userResult.rows.length === 0) {
            client.release();
            if (!res.headersSent) {
                return res.status(401).json({ error: 'User not found' });
            }
            return;
        }
        
        const user = userResult.rows[0];
        
        // CRITICAL: Release client immediately after fetching context
        client.release();
        
        // Store tenant context in request (NO tenant_id for non-dev users)
        req.tenantContext = {
            userId: user.id,
            userEmail: user.email,
            userRole: user.role,
            isGenesisAdmin: user.is_genesis_admin
        };
        
        // TRANSACTION MODE: Store tenant context without SET search_path
        // All queries must use explicit ${tenantSchema}.table_name prefixes
        if (user.role === 'dev') {
            // Dev role: Global access - can query all schemas
            // Uses explicit schema prefixes in queries for multi-tenant access
            req.tenantContext.globalAccess = true;
            // Only dev users get to know about tenant IDs
            req.tenantContext.tenantId = tenant_id;
            req.tenantContext.tenantSchema = tenant_schema;
        } else if (tenant_id && tenant_schema) {
            // Admin/write-only/read-only: Restrict to their tenant schema
            // Routes will use ${tenantSchema}.table_name for isolation
            req.tenantContext.globalAccess = false;
            // Store tenant_id for SERVER-SIDE use (fractal ID generation, routing)
            // sanitizeForRole() will strip it from API responses to prevent horizontal awareness
            req.tenantContext.tenantId = tenant_id;
            req.tenantContext.tenantSchema = tenant_schema;
        } else {
            // User without tenant (shouldn't happen for non-dev users)
            if (!res.headersSent) {
                return res.status(403).json({ error: 'No tenant assigned to user' });
            }
            return;
        }
        
        next();
    } catch (error) {
        console.error('❌ Tenant middleware error:', error);
        // CRITICAL: Always release client on error
        client.release();
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
