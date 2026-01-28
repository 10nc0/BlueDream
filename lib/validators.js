'use strict';

const { z } = require('zod');

const phoneRegex = /^\+?[1-9]\d{1,14}$/;

// SSRF prevention: validate webhook URLs
const safeWebhookUrl = z.string().url('Invalid webhook URL').refine((url) => {
    try {
        const parsed = new URL(url);
        let hostname = parsed.hostname.toLowerCase();
        
        // Strip IPv6 brackets for validation
        if (hostname.startsWith('[') && hostname.endsWith(']')) {
            hostname = hostname.slice(1, -1);
        }
        
        // Block IP literals entirely (DNS rebinding risk) - only allow hostnames
        // This catches IPv4, IPv6, IPv4-mapped IPv6, etc.
        const ipLiteralPattern = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;
        if (ipLiteralPattern.test(hostname)) {
            return false; // Block all IP literals
        }
        
        // Block internal/private hostnames
        const blockedPatterns = [
            /^localhost$/i,
            /\.local$/i,
            /\.internal$/i,
            /\.localhost$/i,
            /^metadata\.google\.internal$/i,
            /\.corp$/i,
            /\.lan$/i,
            /\.home$/i,
            /\.arpa$/i,
        ];
        
        for (const pattern of blockedPatterns) {
            if (pattern.test(hostname)) {
                return false;
            }
        }
        
        // Only allow https for webhooks (security best practice)
        if (parsed.protocol !== 'https:') {
            return false;
        }
        
        return true;
    } catch {
        return false;
    }
}, { message: 'Webhook URL must be HTTPS with a valid public hostname (no IP literals or internal domains)' });

const schemas = {
    login: z.object({
        email: z.string().email('Invalid email format'),
        password: z.string().min(1, 'Password required')
    }),

    signup: z.object({
        email: z.string().email('Invalid email format'),
        password: z.string().min(8, 'Password must be at least 8 characters'),
        tenantKey: z.string().min(1, 'Tenant key required').optional(),
        inviteToken: z.string().optional()
    }),

    forgotPassword: z.object({
        email: z.string().email('Invalid email format')
    }),

    resetPassword: z.object({
        token: z.string().min(1, 'Reset token required'),
        password: z.string().min(8, 'Password must be at least 8 characters')
    }),

    createBook: z.object({
        name: z.string().min(1, 'Book name required').max(100, 'Book name too long'),
        inputPlatform: z.enum(['whatsapp', 'discord', 'manual']).optional().default('whatsapp'),
        userOutputUrl: safeWebhookUrl.optional().nullable(),
        contactInfo: z.string().optional().nullable(),
        tags: z.array(z.string()).optional().default([]),
        outputCredentials: z.object({
            webhooks: z.array(z.object({
                url: safeWebhookUrl,
                name: z.string().max(100).optional()
            })).optional()
        }).optional()
    }),

    updateBook: z.object({
        name: z.string().min(1).max(100).optional(),
        tags: z.array(z.string()).optional(),
        output_01_url: safeWebhookUrl.optional().nullable()
    }),

    createDrop: z.object({
        book_id: z.string().min(1, 'Book ID required'),
        discord_message_id: z.string().min(1, 'Discord message ID required'),
        metadata_text: z.string().min(1, 'Metadata text required')
    }),

    deleteDrop: z.object({
        book_id: z.string().min(1, 'Book ID required'),
        discord_message_id: z.string().min(1, 'Discord message ID required'),
        tag: z.string().optional(),
        date: z.string().optional()
    }),

    twilioWebhook: z.object({
        From: z.string().min(1, 'From number required'),
        To: z.string().min(1, 'To number required'),
        Body: z.string().optional().default(''),
        NumMedia: z.string().optional().default('0'),
        ProfileName: z.string().optional()
    }),

    playgroundQuery: z.object({
        query: z.string().min(1, 'Query required').max(50000, 'Query too long'),
        sessionId: z.string().optional(),
        history: z.array(z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string()
        })).optional().default([])
    }),

    nyanAuditCheck: z.object({
        book_id: z.string().min(1, 'Book ID required'),
        message_id: z.string().min(1, 'Message ID required'),
        content: z.string().optional()
    }),

    createInvite: z.object({
        email: z.string().email('Invalid email format').optional(),
        role: z.enum(['read-only', 'write-only', 'admin']).optional().default('read-only'),
        expiresIn: z.number().positive().optional()
    }),

    updateUserRole: z.object({
        role: z.enum(['read-only', 'write-only', 'admin', 'dev'])
    }),

    updateUserEmail: z.object({
        email: z.string().email('Invalid email format')
    }),

    updateUserPassword: z.object({
        password: z.string().min(8, 'Password must be at least 8 characters')
    })
};

function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const errors = result.error.issues.map(issue => ({
                field: issue.path.join('.'),
                message: issue.message
            }));
            return res.status(400).json({ 
                error: 'Validation failed',
                details: errors
            });
        }
        req.validated = result.data;
        next();
    };
}

function validateQuery(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            const errors = result.error.issues.map(issue => ({
                field: issue.path.join('.'),
                message: issue.message
            }));
            return res.status(400).json({ 
                error: 'Validation failed',
                details: errors
            });
        }
        req.validatedQuery = result.data;
        next();
    };
}

module.exports = {
    schemas,
    validate,
    validateQuery,
    z
};
