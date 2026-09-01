import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  // Fail loudly in the console rather than silently rendering an empty auction.
  console.error(
    "Manca la configurazione Supabase. Crea un file .env.local con VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY."
  );
}

export const supabase = createClient(url || "http://localhost", key || "anon");

/* ── reading ─────────────────────────────────────────────── */

export async function loadAll() {
  const [teams, roster, state, messages] = await Promise.all([
    supabase.from("teams").select("*").order("id"),
    supabase.from("roster").select("*").order("won_at", { ascending: true }),
    supabase.from("auction_state").select("*").eq("id", 1).single(),
    supabase.from("messages").select("*").order("created_at", { ascending: true }).limit(200),
  ]);
  return {
    teams: teams.data || [],
    roster: roster.data || [],
    state: state.data || { phase: "P", lot_id: null },
    messages: messages.data || [],
  };
}

export function subscribeAll(onChange) {
  const channel = supabase.channel("asta-live");
  for (const table of ["teams", "roster", "auction_state", "messages"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, onChange);
  }
  channel.subscribe();
  return () => { supabase.removeChannel(channel); };
}

/* ── the server clock, so nobody's phone can disagree ─────── */

export async function serverOffset() {
  const t0 = Date.now();
  const { data, error } = await supabase.rpc("server_now");
  if (error || !data) return 0;
  const rtt = Date.now() - t0;
  return new Date(data).getTime() + rtt / 2 - Date.now();
}

/* ── writing ─────────────────────────────────────────────── */

async function call(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return data;
}

export const api = {
  claimTeam: (team) => call("claim_team", { p_team: team }),
  checkAdmin: (code) => call("check_admin_code", { p_code: code }),
  placeBid: (team, amount) => call("place_bid", { p_team: team, p_amount: amount }),
  finalize: () => call("finalize_lot", {}),
  openLot: (player, code, messageId = null) =>
    call("open_lot", { p_player: player, p_code: code, p_message_id: messageId }),
  voidLot: (code) => call("void_lot", { p_code: code }),
  advance: (code) => call("advance_phase", { p_code: code }),
  undoLast: (code) => call("undo_last", { p_code: code }),
  rename: (team, name, code) => call("rename_team", { p_team: team, p_name: name, p_code: code }),
  reset: (code) => call("reset_auction", { p_code: code }),
  setAdminCode: (oldCode, newCode) => call("set_admin_code", { p_old: oldCode, p_new: newCode }),
  say: async (team, body, isRequest) => {
    const { error } = await supabase
      .from("messages")
      .insert({ team_id: team, body: body.trim(), is_request: isRequest });
    if (error) throw new Error(error.message);
  },
};
