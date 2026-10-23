-- Run with psql against a disposable local database as a role able to SET ROLE
-- service_role, anon, and authenticated. Requires the migration above first.
-- All fixtures roll back. Do not use this regression test against production.
\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE service_role;
INSERT INTO public.direct_invite_approvals
    (id, guild_id, recipient_key, user_id, username, approved_by)
VALUES
    ('11111111-1111-4111-8111-111111111111', 990001, 'id:990101', 990101, NULL, 990201),
    ('22222222-2222-4222-8222-222222222222', 990001, 'username:invite.test', NULL, 'invite.test', 990201),
    ('33333333-3333-4333-8333-333333333333', 990002, 'id:990101', 990101, NULL, 990201);

DO $$
BEGIN
    IF (SELECT count(*) FROM public.direct_invite_approvals WHERE guild_id IN (990001, 990002)) <> 3 THEN
        RAISE EXCEPTION 'Service role could not insert/read guild-scoped approvals';
    END IF;
    BEGIN
        INSERT INTO public.direct_invite_approvals (guild_id, recipient_key, approved_by)
        VALUES (990001, 'missing', 990201);
        RAISE EXCEPTION 'Missing identity accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO public.direct_invite_approvals (guild_id, recipient_key, username, approved_by)
        VALUES (990001, 'bad-name', 'Display Name', 990201);
        RAISE EXCEPTION 'Display name accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO public.direct_invite_approvals (guild_id, recipient_key, username, approved_by)
        VALUES (990001, 'bad-dots', 'two..dots', 990201);
        RAISE EXCEPTION 'Consecutive dots accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO public.direct_invite_approvals (guild_id, recipient_key, user_id, approved_by)
        VALUES (990001, 'id:990101', 990101, 990201);
        RAISE EXCEPTION 'Duplicate guild/recipient accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END;
$$;

-- Binding preserves the username for audit; future matching can use the ID.
UPDATE public.direct_invite_approvals SET user_id = 990102
WHERE id = '22222222-2222-4222-8222-222222222222' AND user_id IS NULL;

-- Reapproval changes the token. A stale consumer must not remove the new row.
INSERT INTO public.direct_invite_approvals
    (id, guild_id, recipient_key, user_id, approved_by)
VALUES ('44444444-4444-4444-8444-444444444444', 990001, 'id:990101', 990101, 990202)
ON CONFLICT (guild_id, recipient_key) DO UPDATE
SET id = EXCLUDED.id, approved_by = EXCLUDED.approved_by;
DELETE FROM public.direct_invite_approvals
WHERE guild_id = 990001 AND id = '11111111-1111-4111-8111-111111111111';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.direct_invite_approvals
        WHERE id = '44444444-4444-4444-8444-444444444444') THEN
        RAISE EXCEPTION 'Stale consumption removed a new approval';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.direct_invite_approvals
        WHERE username = 'invite.test' AND user_id = 990102) THEN
        RAISE EXCEPTION 'Username binding failed';
    END IF;
END;
$$;

-- Both API-facing roles must be unable to read or forge approvals.
SET LOCAL ROLE anon;
DO $$
BEGIN
    BEGIN
        PERFORM 1 FROM public.direct_invite_approvals;
        RAISE EXCEPTION 'anon can read approvals';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO public.direct_invite_approvals (guild_id, recipient_key, user_id, approved_by)
        VALUES (990001, 'forged', 990103, 990201);
        RAISE EXCEPTION 'anon can forge approvals';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
    BEGIN
        PERFORM 1 FROM public.direct_invite_approvals;
        RAISE EXCEPTION 'authenticated can read approvals';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        INSERT INTO public.direct_invite_approvals (guild_id, recipient_key, user_id, approved_by)
        VALUES (990001, 'forged', 990103, 990201);
        RAISE EXCEPTION 'authenticated can forge approvals';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.direct_invite_approvals'::regclass) THEN
        RAISE EXCEPTION 'RLS is disabled';
    END IF;
END;
$$;
ROLLBACK;
\echo 'direct_invite_approvals regression checks passed'
