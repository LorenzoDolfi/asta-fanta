// The server enforces all of this in SQL. These copies exist so the interface
// can grey out buttons instead of letting people fire doomed requests.

export const ROLES = [
  { key: "P", label: "Portieri", one: "Portiere", slots: 3 },
  { key: "D", label: "Difensori", one: "Difensore", slots: 8 },
  { key: "C", label: "Centrocampisti", one: "Centrocampista", slots: 8 },
  { key: "A", label: "Attaccanti", one: "Attaccante", slots: 6 },
];

export const TOTAL_SLOTS = ROLES.reduce((a, r) => a + r.slots, 0); // 25

export const role = (k) => ROLES.find((r) => r.key === k) || ROLES[0];

export const nextPhase = (k) => {
  const i = ROLES.findIndex((r) => r.key === k);
  return i >= 0 && i < ROLES.length - 1 ? ROLES[i + 1].key : "DONE";
};

export const rosterOf = (roster, teamId) => roster.filter((p) => p.team_id === teamId);

export const countRole = (roster, teamId, k) =>
  roster.filter((p) => p.team_id === teamId && p.role === k).length;

export const roleFull = (roster, teamId, k) => countRole(roster, teamId, k) >= role(k).slots;

// you must keep 1 credit in reserve for every slot you still have to fill
export const maxBid = (team, roster) =>
  team.credits - (TOTAL_SLOTS - rosterOf(roster, team.id).length - 1);

export const missingForPhase = (teams, roster, phase) =>
  phase === "DONE" ? [] : teams.filter((t) => !roleFull(roster, t.id, phase));
