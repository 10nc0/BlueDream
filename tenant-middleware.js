const authService = require('./auth-service');

async function setTenantContext(req, res, next) {
    // Get pool from app locals
    const pool = req.app.locals.pool;
    
    if (!pool) {
        console.error('❌ Pool not available in tenant middleware');
        return res.status(500).json({ error: 'Database connection error' });
    }

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
        
        // If no user, allow request to continue (will be caught by requireAuth)
        if (!userId) {
            req.tenantContext = null;
            return next();
        }
        
        // Get user's tenant and role
        const userResult = await pool.query(`
            SELECT u.id, u.email, u.role, u.tenant_id, u.is_genesis_admin, t.tenant_schema
            FROM users u
            LEFT JOIN core.tenant_catalog t ON u.tenant_id = t.id
            WHERE u.id = $1
        `, [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        
        // Store tenant context in request
        req.tenantContext = {
            userId: user.id,
            userEmail: user.email,
            userRole: user.role,
            tenantId: user.tenant_id,
            tenantSchema: user.tenant_schema,
            isGenesisAdmin: user.is_genesis_admin
        };
        
        // Set PostgreSQL search_path based on role hierarchy
        if (user.role === 'dev') {
            // Dev role: Global access - can query all schemas
            // Don't set search_path, use explicit schema names in queries
            req.tenantContext.globalAccess = true;
            console.log(`🔧 Dev user ${user.email} - Global database access`);
        } else if (user.tenant_id && user.tenant_schema) {
            // Admin/write-only/read-only: Restrict to their tenant schema
            await pool.query(`SET search_path TO ${user.tenant_schema}, public`);
            req.tenantContext.globalAccess = false;
            console.log(`🔒 User ${user.email} - Restricted to ${user.tenant_schema}`);
        } else {
            // User without tenant (shouldn't happen for non-dev users)
            return res.status(403).json({ error: 'No tenant assigned to user' });
        }
        
        next();
    } catch (error) {
        console.error('❌ Tenant middleware error:', error);
        res.status(500).json({ error: 'Tenant context error' });
    }
}

// Helper function to get tenant-scoped query
function getTenantQuery(req, baseQuery, params = []) {
    if (!req.tenantContext) {
        throw new Error('Tenant context not set - middleware not applied');
    }
    
    // Dev users need to specify tenant explicitly or query all
    if (req.tenantContext.globalAccess) {
        // For dev users, we need special handling
        // They should use explicit schema names or query across all tenants
        return { query: baseQuery, params };
    }
    
    // For regular users, search_path is already set to their tenant schema
    return { query: baseQuery, params };
}

// Helper to get all tenant schemas (dev only)
async function getAllTenantSchemas(pool) {
    const result = await pool.query(`
        SELECT id, tenant_schema, genesis_user_id 
        FROM core.tenant_catalog 
        WHERE status = 'active'
        ORDER BY id
    `);
    return result.rows;
}

module.exports = {
    setTenantContext,
    getTenantQuery,
    getAllTenantSchemas
};
