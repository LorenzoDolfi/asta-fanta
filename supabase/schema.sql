-- ============================================================
--  Asta Fantacalcio — Supabase schema
--  Paste this whole file into the Supabase SQL editor and run it.
--  Safe to re-run: it drops and recreates everything.
-- ============================================================

drop table if exists messages cascade;
drop table if exists roster cascade;
drop table if exists auction_state cascade;
drop table if exists teams cascade;
drop table if exists settings cascade;

-- ── settings ────────────────────────────────────────────────
create table settings (
  id                  int primary key default 1,
  admin_code          text not null default 'mister',
  bid_window_seconds  int  not null default 10,
  constraint settings_singleton check (id = 1)
);
insert into settings (id) values (1);

-- ── teams ───────────────────────────────────────────────────
create table teams (
  id      int primary key,
  name    text not null,
  credits int  not null default 500,
  claimed boolean not null default false
);
insert into teams (id, name)
select g, 'Squadra ' || g from generate_series(1, 8) g;

-- ── roster (one row per player won) ─────────────────────────
create table roster (
  id      bigserial primary key,
  team_id int  not null references teams(id) on delete cascade,
  player  text not null,
  role    text not null check (role in ('P','D','C','A')),
  price   int  not null,
  won_at  timestamptz not null default now()
);
create index roster_team_idx on roster(team_id);

-- ── the single live auction row ─────────────────────────────
create table auction_state (
  id          int primary key default 1,
  phase       text not null default 'P' check (phase in ('P','D','C','A','DONE')),
  lot_id      text,
  lot_player  text,
  lot_role    text,
  high_team   int references teams(id),
  high_amount int,
  ends_at     timestamptz,
  constraint auction_singleton check (id = 1)
);
insert into auction_state (id) values (1);

-- ── chat and player nominations ─────────────────────────────
create table messages (
  id         bigserial primary key,
  team_id    int  not null references teams(id),
  body       text not null,
  is_request boolean not null default false,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================
--  Rules, encoded once, server side
-- ============================================================

create or replace function slots_for(p_role text) returns int
language sql immutable as $$
  select case p_role
    when 'P' then 3 when 'D' then 8 when 'C' then 8 when 'A' then 6 else 0 end;
$$;

create or replace function total_slots() returns int
language sql immutable as $$ select 25; $$;

-- a team must keep at least 1 credit for every slot it still has to fill
create or replace function max_bid(p_team int) returns int
language sql stable as $$
  select t.credits - (total_slots()
         - (select count(*) from roster r where r.team_id = t.id) - 1)
  from teams t where t.id = p_team;
$$;

create or replace function teams_missing(p_phase text) returns int
language sql stable as $$
  select count(*)::int from teams t
  where (select count(*) from roster r where r.team_id = t.id and r.role = p_phase)
        < slots_for(p_phase);
$$;

create or replace function server_now() returns timestamptz
language sql stable as $$ select now(); $$;

create or replace function check_admin_code(p_code text) returns boolean
language sql stable security definer
set search_path = public as $$
  -- security definer: settings has no read policy, so this must bypass RLS.
  -- It only ever returns true/false, never the code itself.
  select exists (select 1 from settings where id = 1 and admin_code = p_code);
$$;

create or replace function assert_admin(p_code text) returns void
language plpgsql as $$
begin
  if not check_admin_code(p_code) then
    raise exception 'Codice admin non valido';
  end if;
end $$;

-- ============================================================
--  Actions. Every write goes through one of these.
--  `for update` on the auction row serialises concurrent bids.
-- ============================================================

create or replace function claim_team(p_team int) returns void
language sql security definer as $$
  update teams set claimed = true where id = p_team;
$$;

create or replace function place_bid(p_team int, p_amount int)
returns auction_state
language plpgsql security definer as $$
declare s auction_state; win int;
begin
  select bid_window_seconds into win from settings where id = 1;
  select * into s from auction_state where id = 1 for update;

  if s.lot_id is null then
    raise exception 'Nessun giocatore all''asta';
  end if;
  if s.ends_at is not null and now() > s.ends_at then
    raise exception 'Asta già chiusa';
  end if;
  if p_amount <= coalesce(s.high_amount, 0) then
    raise exception 'Devi superare l''offerta più alta';
  end if;
  if p_amount > max_bid(p_team) then
    raise exception 'Superi il tuo tetto massimo';
  end if;
  if (select count(*) from roster where team_id = p_team and role = s.lot_role)
     >= slots_for(s.lot_role) then
    raise exception 'Hai già completato questo reparto';
  end if;

  update auction_state
     set high_team = p_team,
         high_amount = p_amount,
         ends_at = now() + (win || ' seconds')::interval
   where id = 1
  returning * into s;
  return s;
end $$;

-- idempotent: any client may call it, the server decides if time is really up
create or replace function finalize_lot() returns auction_state
language plpgsql security definer as $$
declare s auction_state;
begin
  select * into s from auction_state where id = 1 for update;
  if s.lot_id is null then return s; end if;
  if s.ends_at is null or now() < s.ends_at then return s; end if;

  if s.high_team is not null then
    insert into roster (team_id, player, role, price)
    values (s.high_team, s.lot_player, s.lot_role, s.high_amount);
    update teams set credits = credits - s.high_amount where id = s.high_team;
  end if;

  update auction_state
     set lot_id = null, lot_player = null, lot_role = null,
         high_team = null, high_amount = null, ends_at = null
   where id = 1
  returning * into s;
  return s;
end $$;

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

create or replace function void_lot(p_code text) returns void
language plpgsql security definer as $$
begin
  perform assert_admin(p_code);
  update auction_state
     set lot_id = null, lot_player = null, lot_role = null,
         high_team = null, high_amount = null, ends_at = null
   where id = 1;
end $$;

create or replace function advance_phase(p_code text) returns void
language plpgsql security definer as $$
declare s auction_state;
begin
  perform assert_admin(p_code);
  select * into s from auction_state where id = 1 for update;
  if s.lot_id is not null then raise exception 'Chiudi prima il lotto in corso'; end if;
  if s.phase = 'DONE' then return; end if;
  if teams_missing(s.phase) > 0 then
    raise exception 'Non tutte le rose hanno completato il reparto';
  end if;
  update auction_state set phase = case s.phase
      when 'P' then 'D' when 'D' then 'C' when 'C' then 'A' else 'DONE' end
   where id = 1;
end $$;

create or replace function undo_last(p_code text) returns void
language plpgsql security definer as $$
declare r roster;
begin
  perform assert_admin(p_code);
  select * into r from roster order by won_at desc, id desc limit 1;
  if not found then return; end if;
  update teams set credits = credits + r.price where id = r.team_id;
  delete from roster where id = r.id;
end $$;

create or replace function rename_team(p_team int, p_name text, p_code text) returns void
language plpgsql security definer as $$
begin
  perform assert_admin(p_code);
  if btrim(coalesce(p_name, '')) = '' then return; end if;
  update teams set name = btrim(p_name) where id = p_team;
end $$;

create or replace function reset_auction(p_code text) returns void
language plpgsql security definer as $$
begin
  perform assert_admin(p_code);
  delete from roster;
  delete from messages;
  update teams set credits = 500, claimed = false;
  update auction_state
     set phase = 'P', lot_id = null, lot_player = null, lot_role = null,
         high_team = null, high_amount = null, ends_at = null
   where id = 1;
end $$;

create or replace function set_admin_code(p_old text, p_new text) returns void
language plpgsql security definer as $$
begin
  perform assert_admin(p_old);
  if length(btrim(coalesce(p_new, ''))) < 4 then
    raise exception 'Il codice deve avere almeno 4 caratteri';
  end if;
  update settings set admin_code = btrim(p_new) where id = 1;
end $$;

-- ============================================================
--  Access: everyone can read, only chat can be written directly,
--  everything else must go through the functions above.
-- ============================================================

alter table teams          enable row level security;
alter table roster         enable row level security;
alter table auction_state  enable row level security;
alter table messages       enable row level security;
alter table settings       enable row level security;

create policy read_teams   on teams          for select using (true);
create policy read_roster  on roster         for select using (true);
create policy read_state   on auction_state  for select using (true);
create policy read_msgs    on messages       for select using (true);
create policy write_msgs   on messages       for insert with check (true);
-- settings has no select policy on purpose: the admin code is never readable

grant execute on function
  server_now(), max_bid(int), teams_missing(text), slots_for(text), total_slots(),
  check_admin_code(text), claim_team(int), place_bid(int, int), finalize_lot(),
  open_lot(text, text, bigint), void_lot(text), advance_phase(text), undo_last(text),
  rename_team(int, text, text), reset_auction(text), set_admin_code(text, text)
to anon, authenticated;

-- ── realtime: push changes to every connected phone ─────────
alter publication supabase_realtime add table teams;
alter publication supabase_realtime add table roster;
alter publication supabase_realtime add table auction_state;
alter publication supabase_realtime add table messages;
