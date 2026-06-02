-- Supabase cloud-sync hardening for the A+ Study app.
-- Run once in the Supabase SQL Editor (project → SQL Editor → New query → Run).
--
-- WHY: the app talks to Postgres with the PUBLIC anon key. The old setup
-- exposed the `progress` table directly with permissive RLS (anon could
-- read every row + overwrite any row). This moves all access behind two
-- SECURITY DEFINER functions that require the sync key, and closes the
-- table to the anon role. Pairs with the app change that calls
-- /rest/v1/rpc/progress_push and /rest/v1/rpc/progress_pull.
--
-- Order of rollout: deploy the app change first (or at the same time).
-- Once you run this, the OLD direct-table sync stops working, so any
-- device still on a cached old build must reload/reinstall to resync.

begin;

-- 1) Lock down the leftover privileged helper. The app never calls it
--    (it only hits /rest/v1/progress[/rpc/...]), so this is safe and
--    clears the two SECURITY DEFINER advisor warnings.
revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
-- If it was only a one-time setup helper you don't need, you can instead:
--   drop function public.rls_auto_enable();

-- 2) Scoped read: returns ONLY the row matching the supplied sync key.
create or replace function public.progress_pull(p_sync_key text)
returns table (data jsonb, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select p.data, p.updated_at
  from public.progress p
  where p.sync_key = p_sync_key;
$$;

-- 3) Scoped write: upsert the caller's own row. updated_at is set here,
--    server-side, so clients can't backdate.
create or replace function public.progress_push(p_sync_key text, p_data jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.progress (sync_key, data, updated_at)
  values (p_sync_key, p_data, now())
  on conflict (sync_key) do update
    set data = excluded.data,
        updated_at = excluded.updated_at;
$$;

-- 4) Close the table to the public API. Drop the permissive policies and
--    revoke direct grants — anon/authenticated can no longer read or
--    write the table directly; only the two functions (which run as the
--    owner and bypass RLS) can. RLS stays ON with no anon policies.
drop policy if exists "anon insert" on public.progress;
drop policy if exists "anon update" on public.progress;
drop policy if exists "anon select" on public.progress;
revoke all on table public.progress from anon, authenticated;

-- 5) Expose exactly the two functions to the public API.
grant execute on function public.progress_pull(text)        to anon, authenticated;
grant execute on function public.progress_push(text, jsonb) to anon, authenticated;

commit;

-- NOTE: security now rests on the sync key being unguessable. Use a long,
-- random sync key (e.g. 20+ random chars), not a dictionary word — the
-- pull function will still return a row to anyone who guesses the key.
