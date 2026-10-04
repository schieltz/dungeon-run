// Events (SPEC: Map > Events): a room, a choice, a cost. Two of them are minigames, The Dealer's Table
// (memory match) and The Blood Wager (push your luck).
// Every event, choice, cost, prize and relic comes from data/events.json and data/relics.json.
// Pure game logic, no DOM: the event's state is plain data in app.view, so a reload picks up mid-game.

import { rollCards } from './cards.js';
import { hasRoomForCompanion, newCard, pickOne, pickWeighted, shuffle, takeCompanion } from './state.js';

// ---------------------------------------------------------------------------
// Run effects: what an event choice, a minigame prize or a relic pickup does to the run.
// Each one reports what happened, for the result screen: a line of text, plus any card, relic or
// companion worth showing. "source" names the event, for lasting effects.

const PLURAL = new Intl.PluralRules('en');
const count = (n, word) => `${n} ${word}${PLURAL.select(n) === 'one' ? '' : 's'}`;

const RUN_EFFECTS = {
  gainGold: (run, data, effect) => {
    run.gold += effect.amount;
    run.stats.goldEarned += effect.amount;
    return { text: `+${effect.amount} gold.` };
  },
  loseGold: (run, data, effect) => {
    const lost = Math.min(run.gold, effect.amount);
    run.gold -= lost;
    return { text: lost ? `−${lost} gold.` : 'You had no gold to lose.' };
  },
  heal: (run, data, effect) => {
    const before = run.player.hp;
    run.player.hp = Math.min(run.player.maxHp, before + effect.amount);
    return { text: `Heal ${effect.amount}: ${before} → ${run.player.hp} HP.` };
  },
  healFull: (run) => {
    const before = run.player.hp;
    run.player.hp = run.player.maxHp;
    return { text: `Healed to full: ${before} → ${run.player.hp} HP.` };
  },
  gainMaxHealth: (run, data, effect) => {
    const before = run.player.maxHp;
    run.player.maxHp += effect.amount;
    run.player.hp += effect.amount;
    return { text: `Max HP ${before} → ${run.player.maxHp}.` };
  },
  loseMaxHealth: (run, data, effect) => {
    const before = run.player.maxHp;
    run.player.maxHp = Math.max(0, before - effect.amount);
    run.player.hp = Math.min(run.player.hp, run.player.maxHp);
    return { text: `Max HP ${before} → ${run.player.maxHp}.` };
  },
  // Losing HP outside a fight can kill you too (the Portal Ruins coming down on you).
  loseHealth: (run, data, effect) => {
    const before = run.player.hp;
    run.player.hp = Math.max(0, before - effect.amount);
    return { text: `You lose ${effect.amount} HP: ${before} → ${run.player.hp}.` };
  },
  // Paying HP outside a fight can kill you. That's the Blood Wager's whole edge.
  payHealth: (run, data, effect) => {
    const before = run.player.hp;
    run.player.hp = Math.max(0, before - effect.amount);
    return { text: `You pay ${effect.amount} HP: ${before} → ${run.player.hp}.` };
  },
  addCurse: (run, data, effect) => {
    const copies = effect.count ?? 1;
    for (let made = 0; made < copies; made++) run.deck.push(newCard(effect.id));
    return { text: `${count(copies, data.cardsById[effect.id].name)} added to your deck.`, card: effect.id };
  },
  addCard: (run, data, effect) => {
    run.deck.push(newCard(effect.id));
    run.stats.cardsAdded += 1;
    return { text: `${data.cardsById[effect.id].name} is added to your deck.`, card: effect.id };
  },
  removeCard: (run, data, effect) => {
    const instance = run.deck.find((card) => card.id === effect.id);
    if (!instance) return { text: '' };
    run.deck = run.deck.filter((card) => card !== instance);
    return { text: `${data.cardsById[effect.id].name} leaves your deck.` };
  },
  addRandomCard: (run, data, effect) => {
    const [id] = rollCards(data, 1, { rarity: effect.rarity, cost: effect.cost });
    if (!id) return { text: 'The page crumbles. Nothing to learn.' };
    run.deck.push(newCard(id));
    run.stats.cardsAdded += 1;
    return { text: `${data.cardsById[id].name} is added to your deck.`, card: id };
  },
  // The player picks the card; the event screen opens a picker for it.
  removeCardChoice: () => ({ pick: 'purge' }),
  // A companion you don't have yet. With no room, they wait for you to make room (the Allies sheet).
  gainRandomCompanion: (run, data) => {
    const strangers = data.companions.companions.filter((c) => !c.eventOnly && !run.companions.includes(c.id));
    if (!strangers.length) return { text: 'No one new is here.' };
    return meetCompanion(run, data, pickOne(strangers).id);
  },
  // A particular companion (the Mysterious King). Companions marked eventOnly only come this way.
  gainCompanion: (run, data, effect) => {
    if (run.companions.includes(effect.id)) return { text: `${data.companionsById[effect.id].name} is already with you.` };
    return meetCompanion(run, data, effect.id);
  },
  grantRunBuff: (run, data, effect) => {
    const buff = data.events.runBuffs[effect.id];
    run.buffs.push({ name: buff.name, text: buff.text, fightsLeft: buff.fights, atFightStart: buff.atFightStart });
    return { text: `${buff.name}: ${buff.text}` };
  },
  enemyBuffNextFights: (run, data, effect, source) => {
    const what = `${effect.stat.charAt(0).toUpperCase()}${effect.stat.slice(1)} +${effect.amount}`;
    const text = `Enemies in your next ${count(effect.fights, 'fight')} start with ${what}.`;
    run.buffs.push({ name: source, text, fightsLeft: effect.fights, enemyStatuses: [{ status: effect.stat, amount: effect.amount }] });
    return { text };
  },
  skipNextReward: (run, data, effect, source) => {
    run.skipNextReward = source;
    return { text: 'After your next fight, there will be no reward.' };
  },
  // A named relic ("id"), one of a rarity, or, with neither, a rarity picked by the elites' odds.
  gainRelic: (run, data, effect) => {
    if (effect.id && run.relics.includes(effect.id)) return { text: `You already carry ${data.relicsById[effect.id].name}.` };
    const id = effect.id ?? rollRelic(run, data, effect.rarity ?? pickWeighted(data.config.rewards.eliteRelicRarityWeights));
    if (!id) return { text: 'Nothing is left to give. You already carry every relic there is.' };
    return { ...takeRelic(run, data, id), relic: id };
  },
};

// A companion joins if there's room; otherwise they wait on the result screen for you to make room.
function meetCompanion(run, data, id) {
  const { name } = data.companionsById[id];
  const joined = hasRoomForCompanion(run, data) && takeCompanion(run, data, id).ok;
  return { text: joined ? `${name} joins you.` : `${name} wants to come with you.`, companion: id, joined };
}

export const runEffectBuilt = (effect) => Boolean(RUN_EFFECTS[effect.type]);

export function runEffects(run, data, effects, source) {
  return effects.filter(runEffectBuilt).map((effect) => RUN_EFFECTS[effect.type](run, data, effect, source));
}

export const bledOut = (run) => run.player.hp <= 0;

// ---------------------------------------------------------------------------
// Relics (data/relics.json): kept for the run. "onPickup" effects happen once; "atFightStart" effects
// happen at the start of every fight (combat.js).

// A relic of the asked-for rarity you don't have. If you have them all, any relic you don't have.
// Relics marked "eventOnly" (the Ancient Tree's) only come from their event, never at random.
export function rollRelic(run, data, rarity) {
  const unowned = data.relics.relics.filter((relic) => !relic.eventOnly && !run.relics.includes(relic.id));
  const ofRarity = unowned.filter((relic) => relic.rarity === rarity);
  const pool = ofRarity.length ? ofRarity : unowned;
  return pool.length ? pickOne(pool).id : null;
}

export function takeRelic(run, data, id) {
  const relic = data.relicsById[id];
  run.relics.push(id);
  runEffects(run, data, relic.onPickup ?? [], relic.name);
  return { text: `You take ${relic.name}.` };
}

// Lasting event effects count down one per fight, starting with the fight that uses them.
export function spendFightBuffs(run) {
  for (const buff of run.buffs) buff.fightsLeft -= 1;
  run.buffs = run.buffs.filter((buff) => buff.fightsLeft > 0);
}

// ---------------------------------------------------------------------------
// The event flow: choose, (play), done. A minigame's two choices are its entry and walking away.

export function eventChoices(def) {
  if (def.type !== 'minigame') return def.choices;
  const entry = { ...def.entry, play: true, effects: [...(def.entry.cost ? [def.entry.cost] : []), ...(def.entry.effects ?? [])] };
  return [entry, { ...def.walkAway, walkAway: true }];
}

// A choice can require something ("gold:100"). Without it the choice is shown but can't be taken.
const CHOICE_REQUIREMENTS = {
  gold: (run, amount) => (run.gold >= Number(amount) ? null : `You need ${amount} gold.`),
};

export function choiceBlocked(run, choice) {
  if (!choice.requires) return null;
  const [name, value] = choice.requires.split(':');
  return CHOICE_REQUIREMENTS[name]?.(run, value) ?? null;
}

export const choiceRequirementBuilt = (choice) => !choice.requires || Boolean(CHOICE_REQUIREMENTS[choice.requires.split(':')[0]]);

export const openEvent = (id) => ({ id, phase: 'choose', chosen: null, results: [], picking: false, game: null });

export function chooseOption(run, data, state, index) {
  const def = data.eventsById[state.id];
  const choice = eventChoices(def)[index];
  if (!choice || state.phase !== 'choose' || choiceBlocked(run, choice)) return;
  state.taken = index;
  state.results = runEffects(run, data, choice.effects ?? [], def.name);
  if (choice.walkAway) state.results.unshift({ text: choice.text, headline: true });
  state.picking = state.results.some((result) => result.pick);
  if (choice.play && !bledOut(run)) {
    state.phase = 'play';
    state.game = MINIGAMES[def.minigame].start(def.rules);
  } else {
    state.phase = 'done';
  }
}

// After an event's "remove a card" choice: the card the player picked.
export function purgeCard(run, data, state, uid) {
  const instance = run.deck.find((card) => card.uid === uid);
  if (!instance) return false;
  run.deck = run.deck.filter((card) => card !== instance);
  state.picking = false;
  state.results.push({ text: `${data.cardsById[instance.id].name} burns away. Gone for good.` });
  return true;
}

// A finished minigame pays out its outcome and the event is done.
function settleGame(run, data, state, outcome) {
  const def = data.eventsById[state.id];
  state.results.push({ text: outcome.text, headline: true }, ...runEffects(run, data, outcome.effects ?? [], def.name));
  state.phase = 'done';
}

// ---------------------------------------------------------------------------
// Minigame conditions in data: a named test ("allPairsFound") or a comparison ("pairsFound>=4").

const COMPARE = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '==': (a, b) => a === b };
const NAMED = { allPairsFound: (game) => game.pairsFound === game.pairs };

function holds(condition, game) {
  if (NAMED[condition]) return NAMED[condition](game);
  const [, field, op, value] = condition.match(/^(\w+)(>=|<=|==|>|<)(\d+)$/) ?? [];
  return Boolean(op) && COMPARE[op](game[field], Number(value));
}

// ---------------------------------------------------------------------------
// The Dealer's Table: memory match. Cards face down, in pairs. Turning over two cards is one flip;
// a match stays face up. A miss stays showing until your next tap, then both turn back.
// Out of flips, or every pair found, and the dead man pays out (or takes his due).

const MINIGAMES = {
  memory_match: {
    start(rules) {
      const faces = Array.from({ length: rules.gridSize }, (_, slot) => slot % rules.pairs); // each face gridSize / pairs times
      return {
        kind: 'memory_match',
        cards: shuffle(faces),
        matched: faces.map(() => false),
        up: [],
        pairs: rules.pairs,
        pairsFound: 0,
        flipsLeft: rules.flipsAllowed,
        over: false,
      };
    },
  },
  push_your_luck: {
    start(rules) {
      return { kind: 'push_your_luck', rounds: rules.rounds, round: 0, prize: null, draws: [], lost: false, over: false };
    },
  },
};

export function flipMemoryCard(run, data, state, index) {
  const game = state.game;
  const perMatch = game.cards.length / game.pairs; // cards in one match
  if (game.over || game.matched[index]) return;
  if (game.up.length === perMatch) game.up = []; // any tap turns the last miss back first
  if (game.up.includes(index)) return;
  game.up.push(index);
  game.last = index; // the card just turned, so only it plays the turning animation
  if (game.up.length < perMatch) return;
  game.flipsLeft -= 1;
  const [first, second] = game.up;
  if (game.cards[first] === game.cards[second]) {
    game.matched[first] = true;
    game.matched[second] = true;
    game.pairsFound += 1;
    game.up = [];
  }
  if (game.pairsFound === game.pairs || game.flipsLeft <= 0) {
    game.over = true;
    const def = data.eventsById[state.id];
    settleGame(run, data, state, def.outcomes.find((outcome) => holds(outcome.condition, game)) ?? { text: '' });
  }
}

// ---------------------------------------------------------------------------
// The Blood Wager: each round, pay that round's HP and draw from the basin. Clean, and the prize climbs
// to that round's prize. The Rot, and everything staked is gone. Stop any time and keep the prize.
// Paying can kill you. The odds and costs are on the board before every draw.

export function wagerDraw(run, data, state) {
  const def = data.eventsById[state.id];
  const game = state.game;
  if (game.over) return;
  const { costPerRound, rotChancePerRound } = def.rules;
  const paid = RUN_EFFECTS.payHealth(run, data, { amount: costPerRound[game.round] });
  if (bledOut(run)) {
    game.over = true;
    state.results.push(paid);
    state.phase = 'done';
    return;
  }
  const rot = Math.random() < rotChancePerRound[game.round];
  game.draws.push(rot ? 'rot' : 'clean');
  if (rot) {
    game.lost = true;
    game.prize = null;
    game.over = true;
    settleGame(run, data, state, { text: 'The Rot. The basin keeps everything you staked.' });
    return;
  }
  game.prize = game.round; // the prize climbs to this round's
  game.round += 1;
  if (game.round >= game.rounds) wagerStop(run, data, state);
}

export function wagerStop(run, data, state) {
  const game = state.game;
  if (game.over) return;
  game.over = true;
  const prize = game.prize === null ? null : data.eventsById[state.id].rules.prizes[game.prize];
  settleGame(run, data, state, prize
    ? { text: `You stop. The basin gives up ${prize.label}.`, effects: prize.effects }
    : { text: 'You put the blade down before the first cut. Nothing staked, nothing won.' });
}
