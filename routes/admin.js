const bcrypt = require('bcrypt');

function registerAdminRoutes(app, deps) {
    const { pool, helpers, logger, middleware } = deps;
    const { logAudit } = helpers;
    const { requireAuth, requireRole } = middleware;

    app.get('/api/sessions', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const tenantSchema = req.tenantSchema;
            const { userId, sortBy = 'login_time', sortOrder = 'desc', filterDevice, filterBrowser, filterLocation } = req.query;
            
            let query = `
                SELECT 
                    s.id, s.user_id, s.session_id, s.ip_address, s.user_agent,
                    s.device_type, s.browser, s.os, s.location, s.login_time, s.last_activity,
                    s.is_active,
                    u.email, u.phone
                FROM ${tenantSchema}.active_sessions s
                LEFT JOIN ${tenantSchema}.users u ON s.user_id = u.id
                WHERE 1=1
            `;
            const params = [];
            let paramCount = 1;
            
            if (userId) {
                query += ` AND s.user_id = $${paramCount}`;
                params.push(userId);
                paramCount++;
            }
            
            if (filterDevice) {
                query += ` AND s.device_type = $${paramCount}`;
                params.push(filterDevice);
                paramCount++;
            }
            
            if (filterBrowser) {
                query += ` AND s.browser = $${paramCount}`;
                params.push(filterBrowser);
                paramCount++;
            }
            
            if (filterLocation) {
                query += ` AND s.location ILIKE $${paramCount}`;
                params.push(`%${filterLocation}%`);
                paramCount++;
            }
            
            const validColumns = ['login_time', 'last_activity', 'device_type', 'browser', 'ip_address', 'location'];
            const sortColumn = validColumns.includes(sortBy) ? sortBy : 'login_time';
            const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
            query += ` ORDER BY s.${sortColumn} ${order}`;
            
            const result = await pool.query(query, params);
            
            res.json({ sessions: result.rows });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching sessions');
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/sessions/:id', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { id } = req.params;
            const tenantSchema = req.tenantSchema;
            
            const sessionResult = await pool.query(`
                SELECT user_id, session_id FROM ${tenantSchema}.active_sessions WHERE id = $1
            `, [id]);
            
            if (sessionResult.rows.length === 0) {
                return res.status(404).json({ error: 'Session not found' });
            }
            
            const session = sessionResult.rows[0];
            
            await pool.query(`
                UPDATE ${tenantSchema}.active_sessions SET is_active = FALSE WHERE id = $1
            `, [id]);
            
            await pool.query(`
                DELETE FROM sessions WHERE sid = $1
            `, [session.session_id]);
            
            await logAudit(pool, req, 'REVOKE_SESSION', 'SESSION', id.toString(), null, {
                target_user_id: session.user_id,
                session_id: session.session_id
            });
            
            res.json({ success: true, message: 'Session revoked' });
        } catch (error) {
            logger.error({ err: error }, 'Error revoking session');
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/sessions/revoke-all', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { userId } = req.body;
            const tenantSchema = req.tenantSchema;
            
            let sessionQuery;
            let params = [];
            
            if (userId) {
                sessionQuery = `SELECT session_id FROM ${tenantSchema}.active_sessions WHERE user_id = $1`;
                params = [userId];
            } else {
                sessionQuery = `SELECT session_id FROM ${tenantSchema}.active_sessions WHERE session_id != $1`;
                params = [req.sessionID];
            }
            
            const sessionsResult = await pool.query(sessionQuery, params);
            const sessionIds = sessionsResult.rows.map(row => row.session_id);
            
            if (sessionIds.length === 0) {
                return res.json({ success: true, message: 'No sessions to revoke', count: 0 });
            }
            
            if (userId) {
                await pool.query(`
                    UPDATE ${tenantSchema}.active_sessions SET is_active = FALSE WHERE user_id = $1
                `, [userId]);
            } else {
                await pool.query(`
                    UPDATE ${tenantSchema}.active_sessions SET is_active = FALSE WHERE session_id != $1
                `, [req.sessionID]);
            }
            
            for (const sessionId of sessionIds) {
                await pool.query('DELETE FROM sessions WHERE sid = $1', [sessionId]);
            }
            
            await logAudit(pool, req, 'REVOKE_ALL_SESSIONS', 'SESSION', userId || 'all', null, {
                count: sessionIds.length,
                target_user_id: userId || 'all'
            });
            
            res.json({ 
                success: true, 
                message: `${sessionIds.length} session(s) revoked`,
                count: sessionIds.length
            });
        } catch (error) {
            logger.error({ err: error }, 'Error revoking all sessions');
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/users', requireAuth, requireRole('admin', 'dev'), async (req, res) => {
        try {
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            const userResult = await pool.query(
                `SELECT role, is_genesis_admin, tenant_id FROM ${tenantSchema}.users WHERE id = $1`,
                [req.userId]
            );
            
            if (!userResult.rows.length) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const user = userResult.rows[0];
            
            let whereClause = '';
            const params = [];
            
            if (user.role !== 'dev') {
                whereClause = 'WHERE tenant_id = $1';
                params.push(user.tenant_id);
            }
            
            const result = await pool.query(`
                SELECT id, email, role, tenant_id, is_genesis_admin, created_at, updated_at
                FROM ${tenantSchema}.users
                ${whereClause}
                ORDER BY created_at DESC
            `, params);
            
            res.json({ users: result.rows });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching users');
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/users/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { id } = req.params;
            const { role } = req.body;
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            if (!role || !['admin', 'read-only', 'write-only'].includes(role)) {
                return res.status(400).json({ error: 'Invalid role. Must be admin, read-only, or write-only' });
            }
            
            const userData = await pool.query(`SELECT email, role, is_genesis_admin FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            if (userData.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const targetUser = userData.rows[0];
            
            if (targetUser.is_genesis_admin) {
                return res.status(403).json({ error: 'Cannot modify role of genesis admin' });
            }
            
            await pool.query(`
                UPDATE ${tenantSchema}.users 
                SET role = $1, updated_at = NOW()
                WHERE id = $2
            `, [role, id]);
            
            await logAudit(pool, req, 'UPDATE_ROLE', 'USER', id, targetUser.email, {
                old_role: targetUser.role,
                new_role: role
            }, tenantSchema);
            
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { id } = req.params;
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            if (parseInt(id) === req.userId) {
                return res.status(400).json({ error: 'Cannot delete your own account' });
            }
            
            const userData = await pool.query(`SELECT email, is_genesis_admin FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            if (userData.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const targetUser = userData.rows[0];
            
            if (targetUser.is_genesis_admin) {
                return res.status(403).json({ error: 'Cannot delete genesis admin' });
            }
            
            await pool.query('DELETE FROM core.user_email_to_tenant WHERE LOWER(email) = $1', [targetUser.email.toLowerCase()]);
            
            await pool.query(`DELETE FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            
            await logAudit(pool, req, 'DELETE_USER', 'USER', id, targetUser.email, {}, tenantSchema);
            
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/users/:id/email', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { id } = req.params;
            const { email: newEmail } = req.body;
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            if (!newEmail || !newEmail.trim()) {
                return res.status(400).json({ error: 'Email is required' });
            }
            
            const normalizedEmail = newEmail.toLowerCase().trim();
            
            const emailCheck = await pool.query(
                'SELECT tenant_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1',
                [normalizedEmail]
            );
            if (emailCheck.rows.length > 0) {
                return res.status(409).json({ error: 'Email already in use' });
            }
            
            const userData = await pool.query(`SELECT email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            if (userData.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const oldEmail = userData.rows[0].email;
            
            await pool.query(`
                UPDATE ${tenantSchema}.users 
                SET email = $1, updated_at = NOW()
                WHERE id = $2
            `, [normalizedEmail, id]);
            
            await pool.query(`
                UPDATE core.user_email_to_tenant 
                SET email = $1
                WHERE LOWER(email) = $2
            `, [normalizedEmail, oldEmail.toLowerCase()]);
            
            await logAudit(pool, req, 'UPDATE_EMAIL', 'USER', id, normalizedEmail, {
                old_email: oldEmail
            }, tenantSchema);
            
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/users/:id/password', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { id } = req.params;
            const { password } = req.body;
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            if (!password || !password.trim()) {
                return res.status(400).json({ error: 'Password is required' });
            }
            
            if (password.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters long' });
            }
            
            const userData = await pool.query(`SELECT email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            if (userData.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const user = userData.rows[0];
            const hashedPassword = await bcrypt.hash(password, 10);
            
            await pool.query(`
                UPDATE ${tenantSchema}.users 
                SET password_hash = $1, updated_at = NOW()
                WHERE id = $2
            `, [hashedPassword, id]);
            
            await logAudit(pool, req, 'UPDATE_PASSWORD', 'USER', id, user.email, {
                updated_by_admin: true
            }, tenantSchema);
            
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/audit-logs', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const tenantSchema = req.tenantSchema;
            const { limit = 100, offset = 0, action_type, target_type } = req.query;
            
            let query = `
                SELECT 
                    id, timestamp, actor_email, action_type, target_type, 
                    target_id, target_email, details, ip_address
                FROM ${tenantSchema}.audit_logs
            `;
            
            const conditions = [];
            const params = [];
            let paramIndex = 1;
            
            if (action_type) {
                conditions.push(`action_type = $${paramIndex++}`);
                params.push(action_type);
            }
            
            if (target_type) {
                conditions.push(`target_type = $${paramIndex++}`);
                params.push(target_type);
            }
            
            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }
            
            query += ` ORDER BY timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
            params.push(limit, offset);
            
            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    logger.info('Admin routes registered (factory pattern)');
}

module.exports = { registerAdminRoutes };
