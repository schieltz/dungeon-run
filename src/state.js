// Run state: the single object holding everything that outlives one fight, plus save and load.
// Everything here is plain data, so the whole game can be written to localStorage after every tap
// and picked up again if Safari reloads the tab.

let uidCounter = 0;
// Unique across reloads too: the timestamp separates sessions, the counter separates ids within one.
export const nextUid = (prefix) => `${prefix}-${Date.now()}-${uidCounter++}`;

export const newCard = (id) => ({ uid: nextUid('card'), id, upgraded: false });

export function createRunState(data, map) {
  const { player, run } = data.config;
  return {
    player: { maxHp: player.startingMaxHp, hp: player.startingMaxHp },
    gold: player.startingGold,
    deck: data.cards.startingDeck.map(newCard),
    secondBreaths: run.secondBreaths,
    companions: [], // companion ids, in the order they joined
    relics: [], // relic ids, in the order found
    buffs: [], // lasting event effects: { name, text, fightsLeft, atFightStart?, enemyStatuses? }
    skipNextReward: null, // the event that cost you your next reward (The Mass Grave)
    map,
    position: null, // id of the node the player is on; null before the first step
    visited: [],
    stats: { fightsWon: 0, enemiesDefeated: 0, goldEarned: 0, turns: 0, breathsUsed: 0, cardsAdded: 0 },
    result: null, // 'won' | 'lost' once the run is over
  };
}

// ---------------------------------------------------------------------------
// Companions (SPEC: Companions). They don't fight and can't be killed; their passives shape the run.
// Up to companions.json "maxCompanions". Taking another past that means dismissing or sacrificing one first.

const refused = (reason) => ({ ok: false, reason });

export const hasRoomForCompanion = (run, data) => run.companions.length < data.companions.maxCompanions;

export function takeCompanion(run, data, id) {
  if (run.companions.includes(id)) return refused('Already with you.');
  if (!hasRoomForCompanion(run, data)) return refused(`You can keep ${data.companions.maxCompanions}. Dismiss or sacrifice one first.`);
  run.companions.push(id);
  return { ok: true };
}

export function dismissCompanion(run, id) {
  run.companions = run.companions.filter((c) => c !== id);
  return { ok: true };
}

// A sacrifice outside a fight can only do what makes sense outside one. In a fight, cards.js runs it.
const RUN_EFFECTS = {
  healFull: (run) => { run.player.hp = run.player.maxHp; },
  removeAllCurses: (run, data) => { run.deck = run.deck.filter((card) => !data.curseIds.has(card.id)); },
};

export const sacrificeWorksOutsideFight = (data, id) =>
  data.companionsById[id].sacrifice.effects.some((effect) => RUN_EFFECTS[effect.type]);

export function sacrificeOutsideFight(run, data, id) {
  if (!run.companions.includes(id)) return refused('Not with you.');
  if (!sacrificeWorksOutsideFight(data, id)) return refused('That sacrifice only works in a fight.');
  for (const effect of data.companionsById[id].sacrifice.effects) RUN_EFFECTS[effect.type]?.(run, data);
  return dismissCompanion(run, id);
}

// ---------------------------------------------------------------------------
// Randomness. Rewards, shops and the map are random; combat never is, beyond the shuffle.

export const randomInt = ([min, max]) => min + Math.floor(Math.random() * (max - min + 1));
export const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

// Pick a key from { key: weight }. Bigger weight, more likely.
export function pickWeighted(weights) {
  const entries = Object.entries(weights).filter(([key, weight]) => !key.startsWith('_') && weight > 0);
  let roll = Math.random() * entries.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return entries.at(-1)?.[0];
}

export function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export const clone = (value) => JSON.parse(JSON.stringify(value));

// Multiply, then round down, without binary floating-point drift: a whole number times a
// decimal multiplier from the JSON must never land one short of the true answer.
export function floorMul(value, multiplier) {
  const [, fraction = ''] = String(multiplier).split('.');
  const scale = 10 ** fraction.length;
  return Math.floor((value * Math.round(multiplier * scale)) / scale);
}

// ---------------------------------------------------------------------------
// Save and load. Storage can be unavailable (private browsing, full disk); the game still runs without it.

const SAVE_KEY = 'dungeon-run/save';
const BEST_KEY = 'dungeon-run/best';

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Saving is a convenience; a failed write must never stop the game.
  }
}

export const loadSave = () => read(SAVE_KEY);
export const writeSave = (snapshot) => write(SAVE_KEY, snapshot);
export const clearSave = () => write(SAVE_KEY, null);

// Best run so far: the deepest node reached, and whether the boss fell.
export const loadBest = () => read(BEST_KEY);
export function recordBest(run) {
  const best = loadBest();
  const depth = run.visited.length;
  const won = run.result === 'won';
  if (!best || (won && !best.won) || (won === best.won && depth > best.depth)) write(BEST_KEY, { depth, won });
}
