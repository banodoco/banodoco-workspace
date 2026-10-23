-- Pending Speaker approvals created by brain-of-bndc's /direct_invite.
-- A username approval is bound to user_id on first match; username stays for audit.
-- The bot replaces id on reapproval so consuming an older approval cannot delete it.
CREATE TABLE IF NOT EXISTS public.direct_invite_approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id bigint NOT NULL CHECK (guild_id > 0),
    recipient_key text NOT NULL CHECK (length(recipient_key) > 0),
    user_id bigint CHECK (user_id > 0),
    username text CHECK (
        username ~ '^[a-z0-9_.]{2,32}$' AND position('..' IN username) = 0
    ),
    approved_by bigint NOT NULL CHECK (approved_by > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT direct_invite_approvals_identity_required
        CHECK (user_id IS NOT NULL OR username IS NOT NULL),
    CONSTRAINT direct_invite_approvals_guild_recipient_key
        UNIQUE (guild_id, recipient_key)
);

CREATE INDEX IF NOT EXISTS direct_invite_approvals_user_idx
    ON public.direct_invite_approvals (guild_id, user_id)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS direct_invite_approvals_username_idx
    ON public.direct_invite_approvals (guild_id, username)
    WHERE user_id IS NULL;

ALTER TABLE public.direct_invite_approvals ENABLE ROW LEVEL SECURITY;

-- Only the server-side bot may read or modify these role-granting approvals.
REVOKE ALL ON TABLE public.direct_invite_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.direct_invite_approvals TO service_role;

DROP POLICY IF EXISTS direct_invite_approvals_service_role ON public.direct_invite_approvals;
CREATE POLICY direct_invite_approvals_service_role
    ON public.direct_invite_approvals
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);
