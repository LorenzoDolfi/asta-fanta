-- ============================================================
--  Patch 01 - run this in the Supabase SQL Editor on an auction
--  that is already live. Safe to run more than once.
--
--  1. Fixes check_admin_code, which could never return true
--     because settings has no read policy for the browser.
--  2. Blocks putting a player up who has already been sold.
--  3. Sets the bidding window to 10 seconds.
--
--  Nothing to redeploy on Vercel for these two - they are
--  database-side only.
-- ============================================================

create or replace function check_admin_code(p_code text) returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (select 1 from settings where id = 1 and admin_code = p_code);
$$;

create or replace function open_lot(p_player text, p_code text, p_message_id bigint default null)
returns auction_state
language plpgsql security definer as $$
declare s auction_state;
begin
  perform assert_admin(p_code);
  select * into s from auction_state where id = 1 for update;

  if s.lot_id is not null then raise exception 'C''è già un lotto aperto'; end if;
  if s.phase = 'DONE' then raise exception 'L''asta è finita'; end if;
  if btrim(coalesce(p_player, '')) = '' then raise exception 'Serve un nome'; end if;
  if teams_missing(s.phase) = 0 then
    raise exception 'Tutte le rose hanno questo reparto completo';
  end if;
  if exists (select 1 from roster r
             where lower(btrim(r.player)) = lower(btrim(p_player))) then
    raise exception 'Giocatore gia'' assegnato';
  end if;

  update auction_state
     set lot_id = gen_random_uuid()::text,
         lot_player = btrim(p_player),
         lot_role = s.phase,
         high_team = null, high_amount = null, ends_at = null
   where id = 1
  returning * into s;

  if p_message_id is not null then
    update messages set used = true where id = p_message_id;
  end if;
  return s;
end $$;

update settings set bid_window_seconds = 10 where id = 1;
