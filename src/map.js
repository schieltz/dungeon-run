// Map: node generation, branching, progression (SPEC: Map).
//
// The dungeon is a column of depths, one node visited per depth. Paths split into separate lanes
// ("braids") for config.map.braidLength depths, then join again at a single node, then split again,
// so the choice is legible at a glance. With guaranteeRestBeforeBoss, the depth before the boss is a
// choice of Rest or Shop. Node types are visible before the player commits.
// Each lane in a braid has its own theme (config.map.laneThemes): one leans on elites, one on fights, one
// on events, one is a mix. Taking the elite lane is the opt-in risk. With guaranteeEvent, the first join
// (a room every path passes through) is an event, so every run meets at least one.

import { rollCards } from './cards.js';
import { newCard, pickOne, pickWeighted, randomInt, shuffle } from './state.js';
import { rollRelic, takeRelic } from './events.js';

export function generateMap(data) {
  const { nodeCount, guaranteeRestBeforeBoss } = data.config.run;
  const shape = data.config.map;
  const rows = [];
  const nodes = {};

  // Shape: how many nodes each depth has, and what kind of row it is.
  let braid = 0;
  let lanes = randomInt(shape.lanes);
  for (let depth = 1; depth <= nodeCount; depth++) {
    let kind = 'braid';
    if (depth === nodeCount) kind = 'boss';
    else if (depth === nodeCount - 1 && guaranteeRestBeforeBoss) kind = 'camp';
    else if (depth % (shape.braidLength + 1) === 0) kind = 'join';
    if (kind === 'join') {
      braid += 1;
      lanes = randomInt(shape.lanes);
    }
    const count = kind === 'braid' ? lanes : kind === 'camp' ? CAMP.length : 1;
    rows.push(Array.from({ length: count }, (_, index) => {
      const node = { id: `n${depth}-${index}`, depth, index, count, kind, braid, type: null, encounter: null, next: [] };
      nodes[node.id] = node;
      return node.id;
    }));
  }

  // Paths: inside a braid each lane runs straight on; everywhere else every node reaches every next node.
  rows.forEach((row, depthIndex) => {
    const nextRow = rows[depthIndex + 1];
    if (!nextRow) return;
    for (const id of row) {
      const node = nodes[id];
      const following = nodes[nextRow[0]];
      const sameBraid = node.kind === 'braid' && following.kind === 'braid' && following.braid === node.braid;
      node.next = sameBraid ? [nextRow[node.index]] : [...nextRow];
    }
  });

  assignTypes(data, rows, nodes);
  assignEncounters(data, nodes);
  return { rows, nodes };
}

const CAMP = ['rest', 'shop'];

function assignTypes(data, rows, nodes) {
  const shape = data.config.map;
  // What may go at a depth: no shop, rest or elite before their first depth.
  const allowedAt = (weights, depth) => {
    const allowed = { ...weights };
    if (depth < shape.firstShopNode) delete allowed.shop;
    if (depth < shape.firstRestNode) delete allowed.rest;
    if (depth < shape.firstEliteNode) delete allowed.elite;
    return allowed;
  };
  const all = Object.values(nodes);
  for (const node of all) {
    if (node.kind === 'boss') node.type = 'boss';
    else if (node.kind === 'camp') node.type = CAMP[node.index];
    else if (node.kind === 'join') node.type = pickWeighted(allowedAt(shape.joinTypeWeights, node.depth));
  }
  const firstJoin = all.filter((node) => node.kind === 'join').sort((a, b) => a.depth - b.depth)[0];
  if (data.config.run.guaranteeEvent && firstJoin) firstJoin.type = 'event';

  for (const braid of new Set(all.filter((n) => n.kind === 'braid').map((n) => n.braid))) {
    const lanes = [];
    for (const node of all.filter((n) => n.kind === 'braid' && n.braid === braid)) (lanes[node.index] ??= []).push(node);
    // A theme whose signature room can't appear in this braid (elites before firstEliteNode) sits it out.
    const fits = (theme) => !theme.atLeastOne || lanes[0].some((n) => allowedAt(theme.weights, n.depth)[theme.atLeastOne]);
    const themes = shuffle(Object.keys(shape.laneThemes).filter((name) => !name.startsWith('_') && fits(shape.laneThemes[name])));
    shuffle(lanes).forEach((lane, i) => {
      const name = themes[i] ?? shape.extraLaneTheme;
      themeLane(lane, name, shape.laneThemes[name], allowedAt);
    });
  }
}

function themeLane(lane, name, theme, allowedAt) {
  for (const node of lane) {
    node.theme = name;
    node.type = pickWeighted(allowedAt(theme.weights, node.depth));
  }
  const must = theme.atLeastOne;
  if (!must || lane.some((node) => node.type === must)) return;
  const room = lane.filter((node) => allowedAt(theme.weights, node.depth)[must]);
  if (room.length) pickOne(room).type = must;
}

// Fights draw from the encounter tier for their depth (config.map.encounterTiers), without repeats
// while fresh ones remain.
function assignEncounters(data, nodes) {
  const { encounters } = data.enemies;
  const tiers = data.config.map.encounterTiers;
  const used = new Set();
  const draw = (tier) => {
    const pool = encounters.filter((e) => e.tier === tier);
    const fresh = pool.filter((e) => !used.has(e.id));
    const encounter = pickOne(fresh.length ? fresh : pool);
    used.add(encounter.id);
    return encounter.id;
  };
  for (const node of Object.values(nodes).sort((a, b) => a.depth - b.depth)) {
    if (node.type === 'combat') node.encounter = draw(tiers.filter((t) => t.fromNode <= node.depth).at(-1).tier);
    if (node.type === 'elite') node.encounter = draw('elite');
    if (node.type === 'boss') node.encounter = draw('boss');
  }
  assignEvents(data, nodes);
}

// Each event room holds one event, without repeats while fresh ones remain.
function assignEvents(data, nodes) {
  const used = new Set();
  for (const node of Object.values(nodes).filter((n) => n.type === 'event').sort((a, b) => a.depth - b.depth)) {
    const fresh = data.events.events.filter((event) => !used.has(event.id));
    node.event = pickOne(fresh.length ? fresh : data.events.events).id;
    used.add(node.event);
  }
}

// ---------------------------------------------------------------------------
// Progression

// The nodes the player may step to next: the first depth at the start, then wherever the paths lead.
export function nextChoices(run) {
  const ids = run.position ? run.map.nodes[run.position].next : run.map.rows[0];
  return ids.map((id) => run.map.nodes[id]);
}

export function enterNode(run, id) {
  if (!nextChoices(run).some((node) => node.id === id)) return null;
  run.position = id;
  run.visited.push(id);
  return run.map.nodes[id];
}

export const currentNode = (run) => (run.position ? run.map.nodes[run.position] : null);
export const FIGHT_TYPES = new Set(['combat', 'elite', 'boss']);

// After a fight: HP, max HP, gold and companions carry back into the run; curses gained there stay in the
// deck, unless a sacrifice cleansed it (then the run's deck loses every curse too).
export function settleFight(run, combat) {
  const { curseIds } = combat.data;
  run.player.hp = combat.player.hp;
  run.player.maxHp = combat.player.maxHp;
  run.gold = combat.gold;
  run.companions = [...combat.companions];
  if (combat.cleansed) run.deck = run.deck.filter((card) => !curseIds.has(card.id));
  for (const id of combat.gainedCurses) run.deck.push(newCard(id));
  run.stats.turns += combat.turn;
  run.stats.enemiesDefeated += combat.kills;
  if (combat.phase === 'won') run.stats.fightsWon += 1;
}

// Winning a fight pays gold and offers a choice of cards. The gold is added now.
// An elite is the risk with the reward: more gold, better odds on the cards ("eliteRarityWeights"),
// a relic every time ("eliteRelicRarityWeights"), and sometimes a prisoner to free.
// An event can cost you the next reward (The Mass Grave): then there is nothing at all.
// An elite sometimes holds a prisoner: a companion the run doesn't have yet (config "eliteCompanionChance").
export function claimRewards(run, node, data) {
  const { rewards } = data.config;
  if (run.skipNextReward) {
    const skippedFor = run.skipNextReward;
    run.skipNextReward = null;
    return { gold: 0, cards: [], companion: null, skippedFor };
  }
  const elite = node.type === 'elite';
  const gold = randomInt(elite ? rewards.goldPerElite : rewards.goldPerCombat);
  run.gold += gold;
  run.stats.goldEarned += gold;
  const cards = rollCards(data, rewards.cardChoiceCount, { weights: elite ? rewards.eliteRarityWeights : undefined });
  const relic = elite ? rollRelic(run, data, pickWeighted(rewards.eliteRelicRarityWeights)) : null;
  if (relic) takeRelic(run, data, relic);
  const strangers = data.companions.companions.filter((c) => !run.companions.includes(c.id));
  const freed = elite && strangers.length && Math.random() < rewards.eliteCompanionChance;
  return { gold, cards, relic, companion: freed ? pickOne(strangers).id : null };
}

export function takeRewardCard(run, id) {
  run.deck.push(newCard(id));
  run.stats.cardsAdded += 1;
}
