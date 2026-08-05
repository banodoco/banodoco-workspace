-- Anti-spam throttle + freshness cache for the refresh-media-urls edge function.
--
-- The function is public (anon-key callable) and each real refresh costs a
-- Supabase edge-function invocation AND a Discord API request. This migration
-- adds:
--
--   * media_refresh_state     — per-message last-SUCCESSFUL-refresh timestamp.
--     Within 24h of a successful refresh, the function delivers the SAME
--     existing URL without calling Discord (no redundant re-sign).
--   * media_refresh_log       — real refresh attempts (non-fresh only), used
--     to enforce the caps. Pruned to the last hour inside the RPC.
--   * check_and_record_refresh(p_message_id, p_caller_ip) -> (allowed,
--     reason, retry_after, fresh):
--       - fresh (state < 24h)  -> allowed=true, reason='cached' — no counting,
--                                  no Discord call.
--       - global cap 60/min    -> denied (429) when over.
--       - per-IP cap 10/min    -> denied (429) when over.
--       - else record + allowed (real refresh).
--   * mark_refresh_done(p_message_id) — upserts the last-successful-refresh
--     timestamp after a successful Discord refresh.
--
-- Both RPCs are SECURITY DEFINER with a fixed search_path and granted ONLY to
-- service_role (the function's Supabase client uses SB_SECRET_KEY). The edge
-- function FAILS OPEN on RPC errors (logs + continues) so a throttle outage
-- never breaks refresh entirely.

create table if not exists public.media_refresh_log (
  id         bigint generated always as identity primary key,
  message_id bigint not null,
  caller_ip  text,
  called_at  timestamptz not null default now()
);

create index if not exists media_refresh_log_called_idx  on public.media_refresh_log (called_at);
create index if not exists media_refresh_log_message_idx on public.media_refresh_log (message_id);
create index if not exists media_refresh_log_ip_idx     on public.media_refresh_log (caller_ip);

create table if not exists public.media_refresh_state (
  message_id        bigint primary key,
  last_refreshed_at timestamptz not null default now()
);
create index if not exists media_refresh_state_last_idx on public.media_refresh_state (last_refreshed_at);

-- The log/state tables must NOT be directly writable by any client: a caller
-- could delete log rows (bypass caps) or set last_refreshed_at (poison the 24h
-- cache). service_role (the function's client) bypasses RLS and keeps its
-- grants; no SELECT/INSERT/UPDATE/DELETE policy is created, so RLS denies all
-- other roles.
alter table public.media_refresh_log   enable row level security;
alter table public.media_refresh_state enable row level security;
revoke all on table public.media_refresh_log, public.media_refresh_state from public;
revoke all on table public.media_refresh_log, public.media_refresh_state from anon;
revoke all on table public.media_refresh_log, public.media_refresh_state from authenticated;

create or replace function public.check_and_record_refresh(
  p_message_id  text,
  p_caller_ip   text,
  p_force_count boolean default false
)
returns table (allowed boolean, reason text, retry_after int, fresh boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_last   timestamptz;
  v_global int;
  v_ip     int;
begin
  -- Bound the logs (cheap indexed deletes on recent-window indexes).
  delete from public.media_refresh_log   where called_at        < now() - interval '1 hour';
  delete from public.media_refresh_state where last_refreshed_at < now() - interval '24 hours';

  -- Fresh within 24h? Serve the cached URL — no Discord, no counting.
  -- p_force_count=true bypasses this: the caller has decided it must do a REAL
  -- Discord refresh (e.g. a "fresh" message whose URLs are near expiry), so
  -- that refresh MUST be counted/gated too (Codex blocker: uncounted
  -- fall-through refreshes would bypass the caps).
  if not p_force_count then
    select last_refreshed_at into v_last
      from public.media_refresh_state
     where message_id = p_message_id::bigint;
    if v_last is not null and now() - v_last < interval '24 hours' then
      return query select true, 'cached', 0, true;
      return;
    end if;
  end if;

  -- Serialize the count-then-insert so concurrent calls can't all observe a
  -- sub-limit count and overshoot the caps (sliding-window, xact-scoped lock).
  perform pg_advisory_xact_lock(963400001);

  -- Real refresh: global cap 60/min.
  select count(*) into v_global
    from public.media_refresh_log
   where called_at > now() - interval '60 seconds';
  if v_global >= 60 then
    return query select false, 'refresh rate limit reached; try again in a minute', 60, false;
    return;
  end if;

  -- Real refresh: per-IP cap 10/min (only when a caller IP is present).
  if p_caller_ip is not null then
    select count(*) into v_ip
      from public.media_refresh_log
     where caller_ip = p_caller_ip
       and called_at > now() - interval '60 seconds';
    if v_ip >= 10 then
      return query select false, 'per-caller refresh rate limit reached; try again in a minute', 60, false;
      return;
    end if;
  end if;

  insert into public.media_refresh_log (message_id, caller_ip)
  values (p_message_id::bigint, p_caller_ip);

  return query select true, 'ok', 0, false;
end;
$$;

create or replace function public.mark_refresh_done(p_message_id text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.media_refresh_state (message_id, last_refreshed_at)
  values (p_message_id::bigint, now())
  on conflict (message_id) do update
    set last_refreshed_at = excluded.last_refreshed_at;
$$;

revoke execute on function public.check_and_record_refresh(text, text, boolean) from public;
revoke execute on function public.check_and_record_refresh(text, text, boolean) from anon;
revoke execute on function public.check_and_record_refresh(text, text, boolean) from authenticated;
grant  execute on function public.check_and_record_refresh(text, text, boolean) to service_role;

revoke execute on function public.mark_refresh_done(text) from public;
revoke execute on function public.mark_refresh_done(text) from anon;
revoke execute on function public.mark_refresh_done(text) from authenticated;
grant  execute on function public.mark_refresh_done(text) to service_role;
