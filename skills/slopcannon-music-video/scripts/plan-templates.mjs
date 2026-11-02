// The sentences the plan builder (slopcannon-agent.mjs plan) writes into a beat to keep mouths
// closed. They live in one place so every caller writes them the same way.

const AND = " and ";
const DURING = " during it.";
const EVERY_MOUTH_CLOSED = "every on-screen mouth stays closed";
const REMAINS_SILENT = " remains silent with mouth closed for the full scene.";
const REMAINS_SILENT_INSTRUMENTAL = " remains vocally silent with mouth closed for the full instrumental scene.";

function offScreenWindow(from, to) {
  return `From ${from} to ${to} an off-screen voice speaks`;
}

function mouthClosed(name) {
  return `${name}'s mouth stays closed`;
}

/** An off-screen line's window, naming the visible mouths that stay closed, or every mouth. */
export function offScreenClause(from, to, names) {
  const closed = names.length > 0 ? names.map(mouthClosed).join(AND) : EVERY_MOUTH_CLOSED;
  return `${offScreenWindow(from, to)}; ${closed}${DURING}`;
}

/** Cast members who stay silent for the whole scene. */
export function silentCastClause(names) {
  return `${names.join(AND)}${REMAINS_SILENT}`;
}

/** The visible vocalist in a scene with no vocal. */
export function instrumentalClause(name) {
  return `${name}${REMAINS_SILENT_INSTRUMENTAL}`;
}
