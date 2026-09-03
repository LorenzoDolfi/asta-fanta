import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { loadAll, subscribeAll, serverOffset, api } from "./lib/db";
import {
  ROLES, TOTAL_SLOTS, role, nextPhase,
  countRole, roleFull, maxBid, missingForPhase,
} from "./lib/rules";
import { fold, searchPlayers, isKnownPlayer } from "./lib/players";

const BID_WINDOW = 10000; // keep in step with settings.bid_window_seconds
const ME_KEY = "asta:me";
const CODE_KEY = "asta:code";

const readLS = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};

export default function App() {
  const [data, setData] = useState(null);
  const [me, setMe] = useState(() => readLS(ME_KEY, null));
  const [code, setCode] = useState(() => readLS(CODE_KEY, ""));
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [muted, setMuted] = useState(false);
  const [tab, setTab] = useState("rose");
  const [toast, setToast] = useState(null);

  const offsetRef = useRef(0);
  const dataRef = useRef(null);
  const finalizingRef = useRef(false);
  const audioRef = useRef(null);
  const mutedRef = useRef(false);
  const lastHighRef = useRef(null);
  const lastWonRef = useRef(null);
  const tickRef = useRef(0);
  const debounceRef = useRef(null);

  offsetRef.current = offset;
  dataRef.current = data;
  mutedRef.current = muted;

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  /* ── sound ─────────────────────────────────────────────── */
  const beep = useCallback((freq, dur = 0.09, vol = 0.06, type = "triangle") => {
    if (mutedRef.current) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioRef.current || (audioRef.current = new Ctx());
      if (ctx.state === "suspended") ctx.resume();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.start(); o.stop(ctx.currentTime + dur);
    } catch { /* audio is a nicety, never a blocker */ }
  }, []);

  const fail = useCallback((e) => {
    setErr(e.message || String(e));
    setTimeout(() => setErr(null), 4500);
  }, []);

  const run = useCallback(async (fn) => {
    setBusy(true);
    try { await fn(); }
    catch (e) { fail(e); }
    finally { setBusy(false); }
  }, [fail]);

  /* ── data ──────────────────────────────────────────────── */
  const refresh = useCallback(async () => {
    try { setData(await loadAll()); } catch (e) { /* transient */ }
  }, []);

  const queueRefresh = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refresh, 80);
  }, [refresh]);

  useEffect(() => {
    (async () => {
      setOffset(await serverOffset());
      await refresh();
    })();
    const unsub = subscribeAll(queueRefresh);
    const poll = setInterval(refresh, 5000);            // safety net if realtime drops
    const resync = setInterval(async () => setOffset(await serverOffset()), 60000);
    return () => { unsub(); clearInterval(poll); clearInterval(resync); };
  }, [refresh, queueRefresh]);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(iv);
  }, []);

  /* ── derived ───────────────────────────────────────────── */
  const s = data?.state;
  const lot = s?.lot_id
    ? {
        id: s.lot_id,
        player: s.lot_player,
        role: s.lot_role,
        high: s.high_team ? { team: s.high_team, amount: s.high_amount } : null,
        endsAt: s.ends_at ? new Date(s.ends_at).getTime() : null,
      }
    : null;

  /* ── reactions: sound, toast ───────────────────────────── */
  useEffect(() => {
    if (!data) return;
    const high = lot?.high?.amount ?? null;
    if (high !== lastHighRef.current) {
      if (high !== null && lot.high.team !== me?.team) beep(760, 0.08, 0.05);
      lastHighRef.current = high;
    }
    const last = data.roster[data.roster.length - 1];
    if (last && last.id !== lastWonRef.current) {
      if (lastWonRef.current !== null) {
        beep(520, 0.1, 0.06);
        setTimeout(() => beep(780, 0.16, 0.06), 110);
        setToast(last);
        setTimeout(() => setToast((t) => (t && t.id === last.id ? null : t)), 6000);
      }
      lastWonRef.current = last.id;
    } else if (!last) {
      lastWonRef.current = null;
    }
  }, [data, lot, me, beep]);

  useEffect(() => {
    if (!lot?.endsAt) return;
    const left = lot.endsAt - serverNow();
    if (left > 0 && left < 3000) {
      const sec = Math.ceil(left / 1000);
      if (tickRef.current !== sec) { tickRef.current = sec; beep(1100, 0.05, 0.045, "square"); }
    }
  }, [now, lot, beep, serverNow]);

  /* ── close the lot when the window expires ─────────────── */
  useEffect(() => {
    const iv = setInterval(() => {
      const st = dataRef.current?.state;
      if (!st?.lot_id || !st.ends_at) return;
      const ends = new Date(st.ends_at).getTime();
      const grace = me?.admin ? 150 : 2000;
      if (serverNow() > ends + grace && !finalizingRef.current) {
        finalizingRef.current = true;
        api.finalize()
          .then(refresh)
          .catch(() => {})
          .finally(() => { finalizingRef.current = false; });
      }
    }, 400);
    return () => clearInterval(iv);
  }, [me, refresh, serverNow]);

  /* ── actions ───────────────────────────────────────────── */
  const join = async (teamId, admin, adminCode) => {
    const next = { team: teamId, admin };
    setMe(next);
    localStorage.setItem(ME_KEY, JSON.stringify(next));
    if (admin) { setCode(adminCode); localStorage.setItem(CODE_KEY, JSON.stringify(adminCode)); }
    try { await api.claimTeam(teamId); } catch { /* cosmetic */ }
    refresh();
  };

  const leave = () => {
    setMe(null);
    localStorage.removeItem(ME_KEY);
  };

  if (!data) {
    return <div className="asta-root"><div className="boot">Carico l'asta…</div></div>;
  }

  const teams = data.teams;
  const roster = data.roster;
  const phase = s.phase;
  const myTeam = me ? teams.find((t) => t.id === me.team) : null;

  return (
    <div className="asta-root">
      <header className="topbar">
        <div className="brand">
          <span className="brand-a">Asta</span>
          <span className="brand-b">Fantacalcio</span>
        </div>
        <div className="topbar-right">
          <button className="ghost sm" onClick={() => setMuted((m) => !m)}>
            {muted ? "Suoni off" : "Suoni on"}
          </button>
          {myTeam && (
            <div className="whoami">
              <span className="whoami-name">{myTeam.name}</span>
              <span className="whoami-cr">{myTeam.credits}<i>cr</i></span>
              {me.admin && <span className="badge-admin">admin</span>}
              <button className="ghost sm" onClick={leave}>Cambia</button>
            </div>
          )}
        </div>
      </header>

      {!me || !myTeam ? (
        <JoinScreen teams={teams} roster={roster} onJoin={join} />
      ) : (
        <>
          <PhaseStrip teams={teams} roster={roster} phase={phase} />
          <main className="layout">
            <section className="col-main">
              <Slab
                lot={lot} phase={phase} teams={teams} roster={roster}
                me={me} myTeam={myTeam} now={now} offset={offset} busy={busy}
                onBid={(amount) => run(() => api.placeBid(me.team, amount).then(refresh))}
              />
              {me.admin && (
                <AdminPanel
                  teams={teams} roster={roster} phase={phase} lot={lot} busy={busy} code={code}
                  onOpen={(name, msgId) => run(() => api.openLot(name, code, msgId).then(refresh))}
                  onVoid={() => run(() => api.voidLot(code).then(refresh))}
                  onAdvance={() => run(() => api.advance(code).then(refresh))}
                  onUndo={() => run(() => api.undoLast(code).then(refresh))}
                  onRename={(id, name) => run(() => api.rename(id, name, code).then(refresh))}
                  onReset={() => run(() => api.reset(code).then(refresh))}
                />
              )}
            </section>

            <aside className="col-side">
              <nav className="tabs">
                {[["rose", "Rose"], ["chat", "Chat"], ["log", "Storico"]].map(([k, l]) => (
                  <button key={k} className={"tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{l}</button>
                ))}
              </nav>
              {tab === "rose" && <Rose teams={teams} roster={roster} me={me} />}
              {tab === "chat" && (
                <Chat
                  teams={teams} messages={data.messages} me={me} phase={phase} lot={lot}
                  onSay={(text, isReq) => run(() => api.say(me.team, text, isReq).then(refresh))}
                  onOpen={(name, msgId) => run(() => api.openLot(name, code, msgId).then(refresh))}
                />
              )}
              {tab === "log" && <Log teams={teams} roster={roster} />}
            </aside>
          </main>
        </>
      )}

      {toast && (
        <div className="toast" key={toast.id}>
          <strong>{toast.player}</strong> a {teams.find((t) => t.id === toast.team_id)?.name} per {toast.price} crediti
        </div>
      )}
      {err && <div className="toast bad">{err}</div>}
    </div>
  );
}

/* ───────────────────────── join ───────────────────────── */

function JoinScreen({ teams, roster, onJoin }) {
  const [wantAdmin, setWantAdmin] = useState(false);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");

  const pick = async (id) => {
    if (!wantAdmin) return onJoin(id, false, "");
    try {
      const ok = await api.checkAdmin(code);
      if (!ok) { setMsg("Codice admin sbagliato."); return; }
      onJoin(id, true, code);
    } catch (e) { setMsg(e.message); }
  };

  return (
    <div className="join">
      <h1 className="join-title">Scegli la tua squadra</h1>
      <p className="join-sub">500 crediti a testa. 3 portieri, 8 difensori, 8 centrocampisti, 6 attaccanti.</p>

      <div className="join-grid">
        {teams.map((t) => (
          <button key={t.id} className="join-card" onClick={() => pick(t.id)}>
            <span className="join-num">{t.id}</span>
            <span className="join-name">{t.name}</span>
            <span className="join-meta">
              {t.credits} cr · {roster.filter((p) => p.team_id === t.id).length}/{TOTAL_SLOTS}
            </span>
            {t.claimed && <span className="join-tag">già in uso</span>}
          </button>
        ))}
      </div>

      <div className="join-admin">
        <label className="check">
          <input type="checkbox" checked={wantAdmin}
                 onChange={(e) => { setWantAdmin(e.target.checked); setMsg(""); }} />
          Entro come admin
        </label>
        {wantAdmin && (
          <input className="field" type="password" placeholder="Codice admin"
                 value={code} onChange={(e) => { setCode(e.target.value); setMsg(""); }} />
        )}
        {msg && <span className="err">{msg}</span>}
      </div>
    </div>
  );
}

/* ───────────────────────── phase strip ───────────────────────── */

function PhaseStrip({ teams, roster, phase }) {
  return (
    <div className="phases">
      {ROLES.map((r) => {
        const done = roster.filter((p) => p.role === r.key).length;
        const total = r.slots * teams.length;
        const active = phase === r.key;
        const complete = total > 0 && done >= total;
        return (
          <div key={r.key} className={"phase" + (active ? " on" : "") + (complete ? " done" : "")}>
            <span className="phase-name">{r.label}</span>
            <span className="phase-count">{done}<i>/{total}</i></span>
            <span className="phase-bar"><i style={{ width: total ? `${(done / total) * 100}%` : "0%" }} /></span>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── the auction slab ───────────────────────── */

function Slab({ lot, phase, teams, roster, me, myTeam, now, offset, busy, onBid }) {
  const [input, setInput] = useState("");
  const seen = useRef("");
  const high = lot?.high?.amount ?? 0;
  const sig = lot ? `${lot.id}:${high}` : "";

  useEffect(() => {
    if (seen.current === sig) return;
    seen.current = sig;
    setInput(lot ? String(high + 1) : "");
  }, [sig, lot, high]);

  if (phase === "DONE") {
    return (
      <div className="slab empty">
        <div className="slab-empty-title">Asta completata</div>
        <p className="slab-empty-sub">Tutte le rose sono piene. Buon fantacalcio.</p>
      </div>
    );
  }

  if (!lot) {
    return (
      <div className="slab empty">
        <div className="slab-empty-title">Nessun giocatore all'asta</div>
        <p className="slab-empty-sub">
          Si stanno chiamando i {role(phase).label.toLowerCase()}. Proponi un nome in chat:
          l'admin decide chi va all'asta.
        </p>
      </div>
    );
  }

  const cap = maxBid(myTeam, roster);
  const full = roleFull(roster, me.team, lot.role);
  const iAmHigh = lot.high?.team === me.team;
  const canBid = !full && !iAmHigh && cap > high;
  const left = lot.endsAt ? Math.max(0, lot.endsAt - (now + offset)) : null;
  const secs = left === null ? null : left / 1000;
  const urgent = secs !== null && secs <= 3;

  const submit = (amount) => {
    if (!canBid || busy) return;
    const v = Math.floor(Number(amount));
    if (!Number.isFinite(v) || v <= high || v > cap) return;
    onBid(v);
  };

  let blocked = null;
  if (full) blocked = `Hai già completato i ${role(lot.role).label.toLowerCase()}.`;
  else if (iAmHigh) blocked = "Sei tu il miglior offerente.";
  else if (cap <= high) blocked = `Non puoi superare ${cap} crediti.`;

  return (
    <div className={"slab" + (urgent ? " urgent" : "")}>
      <div className="slab-head">
        <span className="rolechip">{role(lot.role).one}</span>
        <span className="slab-cap">Tetto massimo per te: <b>{Math.max(cap, 0)}</b></span>
      </div>

      <h2 className="player">{lot.player}</h2>

      <div className="board">
        <div className="board-bid">
          <span className="board-label">Offerta</span>
          <span className="board-num">{high || "—"}</span>
          <span className="board-who">
            {lot.high ? teams.find((t) => t.id === lot.high.team)?.name : "nessuna offerta"}
          </span>
        </div>
        <div className={"board-timer" + (urgent ? " hot" : "")}>
          <span className="board-label">Chiusura</span>
          <span className="board-num">{secs === null ? "—" : secs.toFixed(1)}</span>
          <span className="board-who">{secs === null ? "apre alla prima offerta" : "secondi"}</span>
        </div>
      </div>

      <div className="drain">
        <i style={{ width: left === null ? "0%" : `${Math.min(100, (left / BID_WINDOW) * 100)}%` }} />
      </div>

      {blocked ? (
        <p className="blocked">{blocked}</p>
      ) : (
        <div className="bidbar">
          <div className="quick">
            {[1, 5, 10].map((n) => (
              <button key={n} className="qbtn" disabled={busy || high + n > cap}
                      onClick={() => submit(high + n)}>
                <span>+{n}</span><i>{high + n}</i>
              </button>
            ))}
          </div>
          <div className="custom">
            <input className="bidfield" type="number" inputMode="numeric"
                   min={high + 1} max={cap} value={input}
                   onChange={(e) => setInput(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") submit(input); }}
                   aria-label="La tua offerta" />
            <button className="offri" disabled={busy} onClick={() => submit(input)}>Offri</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── admin ───────────────────────── */

function AdminPanel({ teams, roster, phase, lot, busy, onOpen, onVoid, onAdvance, onUndo, onRename, onReset }) {
  const [openNames, setOpenNames] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const missing = missingForPhase(teams, roster, phase);
  const last = roster[roster.length - 1];
  const done = phase === "DONE";
  const complete = missing.length === 0;

  return (
    <div className="admin">
      <PlayerPicker
        phase={phase} roster={roster} busy={busy}
        disabled={!!lot || done || complete}
        onNominate={(playerName) => onOpen(playerName, null)}
      />

      <div className="admin-row wrap">
        {lot && <button className="ghost danger" onClick={onVoid}>Annulla il lotto in corso</button>}
        <button className="ghost" disabled={busy || !last} onClick={onUndo}>
          {last ? `Annulla: ${last.player} (${last.price})` : "Niente da annullare"}
        </button>
        <button className="ghost" disabled={busy || !complete || !!lot || done} onClick={onAdvance}>
          {done ? "Asta finita"
            : nextPhase(phase) === "DONE" ? "Chiudi l'asta"
            : `Passa ai ${role(nextPhase(phase)).label.toLowerCase()}`}
        </button>
        <button className="ghost" onClick={() => setOpenNames((v) => !v)}>Nomi squadre</button>
        <button className={"ghost" + (confirmReset ? " danger" : "")}
                onClick={() => { if (confirmReset) { onReset(); setConfirmReset(false); } else setConfirmReset(true); }}>
          {confirmReset ? "Confermi? Azzera tutto" : "Azzera asta"}
        </button>
      </div>

      {!done && complete && (
        <p className="admin-note">
          Tutte le rose hanno i {role(phase).label.toLowerCase()} completi. Puoi passare al reparto successivo.
        </p>
      )}
      {!done && !complete && (
        <p className="admin-note">
          Devono ancora completare i {role(phase).label.toLowerCase()}:{" "}
          {missing.map((t) => `${t.name} (${countRole(roster, t.id, phase)}/${role(phase).slots})`).join(", ")}
        </p>
      )}

      {openNames && (
        <div className="names">
          {teams.map((t) => <NameField key={t.id} team={t} onRename={onRename} />)}
        </div>
      )}
    </div>
  );
}

/* Autocomplete over the Serie A list: current position only, sold players hidden. */
function PlayerPicker({ phase, roster, busy, disabled, onNominate }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef(null);

  const taken = useMemo(() => new Set(roster.map((p) => fold(p.player))), [roster]);
  const results = useMemo(
    () => (disabled ? [] : searchPlayers(q, phase, taken)),
    [q, phase, taken, disabled]
  );

  useEffect(() => { setHi(0); }, [q, phase]);
  useEffect(() => { setQ(""); setOpen(false); }, [phase]);

  const pick = (p) => {
    setQ(p.name);
    setOpen(false);
    inputRef.current?.focus();
  };

  const nominate = () => {
    const name = q.trim();
    if (!name || disabled || busy) return;
    onNominate(name);
    setQ("");
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (open && results.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % results.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setHi((h) => (h - 1 + results.length) % results.length); return; }
      if (e.key === "Enter")     { e.preventDefault(); pick(results[hi]); return; }
      if (e.key === "Escape")    { setOpen(false); return; }
    }
    if (e.key === "Enter") nominate();
  };

  const known = q.trim() && isKnownPlayer(q, phase);
  const label = done_label(phase, disabled);

  return (
    <div className="picker-wrap">
      <div className="admin-row">
        <div className="picker">
          <input
            ref={inputRef} className="field grow" placeholder={label} value={q}
            disabled={disabled} autoComplete="off"
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={onKeyDown}
          />
          {open && results.length > 0 && (
            <ul className="suggest">
              {results.map((p, i) => (
                <li key={p.name}
                    className={"suggest-row" + (i === hi ? " on" : "")}
                    onMouseDown={(e) => { e.preventDefault(); pick(p); }}
                    onMouseEnter={() => setHi(i)}>
                  <span className="suggest-name">{p.name}</span>
                  <span className="suggest-club">{p.club}</span>
                  <span className="suggest-q" title="Quotazione">{p.q}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="primary" disabled={busy || disabled || !q.trim()} onClick={nominate}>
          Metti all'asta
        </button>
      </div>
      {q.trim() && !known && !disabled && (
        <p className="admin-note">
          "{q.trim()}" non e' fra i {role(phase).label.toLowerCase()} in lista. Puoi comunque metterlo all'asta.
        </p>
      )}
    </div>
  );
}

function done_label(phase, disabled) {
  if (disabled) return "Non e' il momento di chiamare un giocatore";
  return `Cerca un ${role(phase).one.toLowerCase()}...`;
}

function NameField({ team, onRename }) {
  const [v, setV] = useState(team.name);
  useEffect(() => { setV(team.name); }, [team.name]);
  return (
    <div className="name-row">
      <span className="name-num">{team.id}</span>
      <input className="field" value={v}
             onChange={(e) => setV(e.target.value)}
             onBlur={() => { if (v.trim() && v !== team.name) onRename(team.id, v); }}
             onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
    </div>
  );
}

/* ───────────────────────── rosters ───────────────────────── */

function Rose({ teams, roster, me }) {
  const ordered = [...teams].sort((a, b) => (a.id === me.team ? -1 : b.id === me.team ? 1 : a.id - b.id));
  return (
    <div className="panel scroll">
      {ordered.map((t) => {
        const mine = roster.filter((p) => p.team_id === t.id);
        return (
          <details key={t.id} className={"rosa" + (t.id === me.team ? " mine" : "")} open={t.id === me.team}>
            <summary>
              <span className="rosa-name">{t.name}</span>
              <span className="rosa-cr">{t.credits}<i>cr</i></span>
              <span className="pips">
                {ROLES.map((r) => (
                  <span key={r.key} className="pipgroup" title={r.label}>
                    <b>{r.key}</b>{countRole(roster, t.id, r.key)}<i>/{r.slots}</i>
                  </span>
                ))}
              </span>
            </summary>
            <div className="rosa-body">
              {ROLES.map((r) => {
                const list = mine.filter((p) => p.role === r.key);
                if (!list.length) return null;
                return (
                  <div key={r.key} className="rosa-group">
                    <span className="rosa-group-h">{r.label}</span>
                    {list.map((p) => (
                      <div key={p.id} className="rosa-p"><span>{p.player}</span><b>{p.price}</b></div>
                    ))}
                  </div>
                );
              })}
              {!mine.length && <p className="muted">Rosa vuota.</p>}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/* ───────────────────────── chat ───────────────────────── */

function Chat({ teams, messages, me, phase, lot, onSay, onOpen }) {
  const [text, setText] = useState("");
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length]);

  const send = (asRequest) => {
    if (!text.trim()) return;
    onSay(text, asRequest);
    setText("");
  };

  return (
    <div className="panel chat">
      <div className="feed">
        {messages.length === 0 && (
          <p className="muted pad">Ancora nessun messaggio. Proponi il prossimo giocatore.</p>
        )}
        {messages.map((m) => (
          <div key={m.id}
               className={"msg" + (m.is_request ? " req" : "") + (m.team_id === me.team ? " mine" : "")}>
            <span className="msg-team">{teams.find((t) => t.id === m.team_id)?.name || `Squadra ${m.team_id}`}</span>
            <span className="msg-text">{m.is_request ? `Propone: ${m.body}` : m.body}</span>
            {m.is_request && me.admin && !m.used && !lot && phase !== "DONE" && (
              <button className="mini" onClick={() => onOpen(m.body, m.id)}>All'asta</button>
            )}
            {m.is_request && m.used && <span className="msg-used">fatto</span>}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="chat-input">
        <input className="field grow" placeholder="Scrivi o proponi un nome…"
               value={text} onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") send(false); }} />
        <button className="ghost sm" onClick={() => send(false)}>Invia</button>
        <button className="primary sm" onClick={() => send(true)}>Proponi</button>
      </div>
    </div>
  );
}

/* ───────────────────────── log ───────────────────────── */

function Log({ teams, roster }) {
  if (!roster.length) {
    return <div className="panel"><p className="muted pad">Nessun giocatore assegnato.</p></div>;
  }
  return (
    <div className="panel scroll">
      {[...roster].reverse().map((e) => (
        <div key={e.id} className="logrow">
          <span className="logrole">{e.role}</span>
          <span className="logplayer">{e.player}</span>
          <span className="logteam">{teams.find((t) => t.id === e.team_id)?.name}</span>
          <b className="logprice">{e.price}</b>
        </div>
      ))}
    </div>
  );
}
