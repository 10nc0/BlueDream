'use strict';
const { MISC } = require('../config/constants');
const days = Math.max(1, Number(MISC.SHARE_INVITE_TIMEOUT_DAYS) || 7);
// Request-time authorization must not depend on when a janitor runs. A share
// accepted by registration during its invitation window remains valid.
const LIVE_SHARE_SQL = `(bs.invited_at >= NOW() - (${days} * INTERVAL '1 day') OR EXISTS (
    SELECT 1 FROM core.user_email_to_tenant uet
    WHERE LOWER(uet.email) = LOWER(bs.shared_with_email)
      AND uet.created_at <= bs.invited_at + (${days} * INTERVAL '1 day')
))`;
const LIVE_PHONE_SQL = `(ep.is_creator = true OR ep.last_engaged_at >= NOW() - INTERVAL '60 days' OR EXISTS (
    SELECT 1 FROM core.book_engaged_phones registered
    WHERE registered.phone = ep.phone AND registered.is_creator = true
))`;
module.exports = { LIVE_SHARE_SQL, LIVE_PHONE_SQL };
