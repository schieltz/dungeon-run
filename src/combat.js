// Combat: turn loop, damage resolution, status effects.
// Pure game logic, no DOM. Every number comes from combat.data, which is the /data JSON files.
// What happened is recorded into combat.log as plain objects; log.js turns those into the arithmetic the player reads.
// The combat object is plain data (apart from `data`), so it can be saved and restored mid-fight.

import { applyEffects, firePowers, resolveCard } from './cards.js';
import { livingSummons, resolveEnemyTarget, summonTarget } from './summons.js';
import { clone, floorMul, newCard, nextUid, shuffle } from './state.js';

// Two of the same enemy in one fight get told apart as "Dungeon Rat A" and "Dungeon Rat B",
// so an intent or a summon's target never names an enemy ambiguously. Summons are marked the same way.
export const MARKS = 'ABCDEFGHIJKL';

export function createCombat(run, encounter, data) {
  const combat = {
    data,
    encounterId: encounter.id,
    turn: 0,
    phase: 'player', // player | enemy | won | lost
    player: {
      uid: 'player', id: 'player', kind: 'player', name: 'You',
      hp: run.player.hp, maxHp: run.player.maxHp, block: 0, blockKept: 0, energy: 0, statuses: {},
    },
    enemies: [],
    summons: [], // in the order they were summoned
    corpses: [], // enemies that died this fight, oldest first
    powers: [], // powers in play for the rest of the fight
    endOfTurn: [], // damage waiting for the end of the turn (Darkhold Pact)
    gainedCurses: [], // curses that stay in the deck after the fight
    cleansed: false, // a sacrifice removed every curse; the run's deck loses them too when the fight settles
    companions: [...(run.companions ?? [])], // a mid-fight sacrifice removes one here; the run follows when the fight settles
    gold: run.gold, // Golden Light spends it; the run gets it back when the fight settles
    shot: { bonuses: 0, energyNextTurn: 0 }, // Call Your Shot this turn
    kills: 0,
    piles: { draw: shuffle(clone(run.deck)), hand: [], discard: [], exhaust: [] },
    log: [],
  };
  combat.enemies = markTwins(encounter.enemies.map((id) => makeEnemy(data.enemiesById[id])));
  // An event's lasting effect can strengthen every enemy in the next few fights, newcomers included.
  combat.enemyStatuses = (run.buffs ?? []).flatMap((buff) => (buff.enemyStatuses ?? []).map((status) => ({ ...status, source: buff.name })));
  noteUnbuiltPassives(combat);
  startPlayerTurn(combat, data.config.player.startingHandDraw);
  fightStartEffects(combat, run);
  return combat;
}

// After the first draw: relics and lasting event effects that act at the start of every fight.
function fightStartEffects(combat, run) {
  for (const id of run.relics ?? []) {
    const relic = combat.data.relicsById[id];
    if (relic?.atFightStart) applyEffects(combat, relic.atFightStart, relic.name);
  }
  for (const buff of run.buffs ?? []) {
    if (buff.atFightStart) applyEffects(combat, buff.atFightStart, buff.name);
  }
  strengthen(combat, combat.enemies);
}

function strengthen(combat, enemies) {
  for (const { status, amount, source } of combat.enemyStatuses ?? []) {
    for (const enemy of enemies) applyStatus(combat, enemy, status, { amount }, source);
  }
}

// A fight frozen as plain data, for Second Breath and for saving. Thawing puts the data back.
export function freezeCombat(combat) {
  const { data, ...rest } = combat;
  return clone(rest);
}
export const thawCombat = (frozen, data) => ({ ...clone(frozen), data });

// A summon the crab's beam stole carries its own definition (its HP and attack came with it).
export const enemyDef = (combat, enemy) => enemy.def ?? combat.data.enemiesById[enemy.id];

// "turns" counts the enemy's own actions, for abilities that fire every few turns (the crab's beam).
function makeEnemy(def, { splitDepth } = {}) {
  const enemy = {
    uid: nextUid(def.id), id: def.id, kind: 'enemy', name: def.name,
    hp: def.hp, maxHp: def.hp, block: 0, statuses: {}, intentIndex: 0, turns: 0,
    splitDepth: splitDepth ?? def.splitDepth ?? 0,
  };
  setUpPassives(enemy, def);
  return enemy;
}

// Passives that keep count during the fight (Encrusted Armor) set up their counter here.
function setUpPassives(enemy, def) {
  for (const passive of builtPassives(def)) PASSIVES[passive.type].setup?.(enemy, passive);
}

// A fight saved by an earlier build: give its enemies the counters added since.
export function catchUpEnemies(combat) {
  for (const enemy of combat.enemies) {
    if (enemy.turns !== undefined) continue;
    enemy.turns = 0; // its timed abilities count from now
    setUpPassives(enemy, enemyDef(combat, enemy));
  }
}

function markTwins(enemies) {
  for (const enemy of enemies) {
    const twins = enemies.filter((other) => other.id === enemy.id);
    if (twins.length > 1) enemy.name = `${enemy.name} ${MARKS[twins.indexOf(enemy)]}`;
  }
  return enemies;
}

// Enemies that arrive mid-fight (a Blood Blob's split, the crab's Barnacles) always get a letter,
// the first one no living enemy of that kind is using (so a long fight never runs out of letters).
function joinFight(combat, id, count, { after, splitDepth, source }) {
  const def = combat.data.enemiesById[id];
  const used = new Set(livingEnemies(combat).filter((enemy) => enemy.id === id).map((enemy) => enemy.name));
  const newcomers = Array.from({ length: count }, () => makeEnemy(def, { splitDepth }));
  for (const enemy of newcomers) {
    enemy.name = `${def.name} ${[...MARKS].find((mark) => !used.has(`${def.name} ${mark}`))}`;
    used.add(enemy.name);
  }
  const at = after ? combat.enemies.indexOf(after) + 1 : combat.enemies.length;
  combat.enemies.splice(at, 0, ...newcomers);
  record(combat, { kind: 'info', text: `${source}: ${newcomers.map((enemy) => enemy.name).join(' and ')} ${count > 1 ? 'join' : 'joins'} the fight.` });
  strengthen(combat, newcomers);
}

export const livingEnemies = (combat) => combat.enemies.filter((enemy) => enemy.hp > 0);
const alliesOf = (combat, enemy) => livingEnemies(combat).filter((other) => other !== enemy);

// ---------------------------------------------------------------------------
// Turn order (SPEC: Combat turn order)

// Start of player turn: block resets (except block meant to last), draw up to hand size, energy refills,
// status durations tick down.
function startPlayerTurn(combat, handSize) {
  const { player } = combat;
  combat.turn += 1;
  combat.phase = 'player';
  record(combat, { kind: 'turn', turn: combat.turn });
  player.block = Math.min(player.block, player.blockKept);
  player.blockKept = 0;
  drawTo(combat, handSize);
  player.energy = combat.data.config.player.energyPerTurn + combat.shot.energyNextTurn;
  combat.shot = { bonuses: 0, energyNextTurn: 0 };
  tickStatuses([player, ...livingSummons(combat), ...livingEnemies(combat)]);
}

// Player ends their turn: summons act, enemies act, end-of-turn effects, hand discards, next turn begins.
export function endPlayerTurn(combat) {
  if (combat.phase !== 'player') return;
  combat.phase = 'enemy';
  if (firePassives(combat, 'onPlayerEndTurn', livingEnemies(combat))) return;
  if (summonsAct(combat)) return;

  record(combat, { kind: 'phase', text: 'Enemy turn' });
  // An enemy's block and burrow last until its side's next turn begins.
  for (const enemy of livingEnemies(combat)) {
    enemy.block = 0;
    delete enemy.statuses.burrowed;
  }
  for (const enemy of livingEnemies(combat)) {
    if (enemy.hp <= 0) continue; // killed earlier this phase
    actEnemy(combat, enemy);
    if (checkOutcome(combat)) return;
    if (firePassives(combat, 'afterAct', [enemy])) return;
  }

  if (resolveEndOfTurn(combat)) return;
  discardHand(combat);
  startPlayerTurn(combat, combat.data.config.player.handSize);
}

// Summons act after the player and before the enemies, in the order they were summoned,
// each attacking its assigned target. Returns true if that ended the fight.
function summonsAct(combat) {
  const attackers = livingSummons(combat).filter((summon) => summon.attack);
  if (attackers.length) record(combat, { kind: 'phase', text: 'Your summons attack' });
  for (const summon of attackers) {
    const target = summonTarget(combat, summon);
    if (target && summon.hp > 0) dealDamage(combat, { source: summon.name, attacker: summon, target, amount: summon.attack });
    if (checkOutcome(combat)) return true;
  }
  return false;
}

// End of turn: Burn, damage waiting for the end of the turn (Darkhold Pact), and curses in hand that
// hurt you at the end of your turn (Doubt). Returns true if that ended the fight.
function resolveEndOfTurn(combat) {
  for (const unit of [combat.player, ...livingSummons(combat), ...livingEnemies(combat)]) {
    if (unit.statuses.burn && unit.hp > 0) takeDamage(combat, unit, unit.statuses.burn.amount, 'Burn');
  }
  const pending = combat.endOfTurn;
  combat.endOfTurn = [];
  for (const { amount, source, own } of pending) takeDamage(combat, combat.player, amount, source, { own });
  for (const instance of combat.piles.hand) {
    const card = resolveCard(combat.data, instance);
    if (!card.unplayable) continue;
    for (const effect of card.effects ?? []) {
      if (effect.type === 'delayedDamage') takeDamage(combat, combat.player, effect.amount, card.name);
    }
  }
  return checkOutcome(combat);
}

export function scheduleEndOfTurn(combat, amount, source) {
  combat.endOfTurn.push({ amount, source, own: true });
  record(combat, { kind: 'info', text: `${source}: you will take ${amount} damage at the end of your turn.` });
}

export function checkOutcome(combat) {
  if (combat.phase === 'won' || combat.phase === 'lost') return true;
  if (combat.player.hp <= 0) combat.phase = 'lost';
  else if (!livingEnemies(combat).length) combat.phase = 'won';
  else return false;
  record(combat, { kind: 'outcome', won: combat.phase === 'won' });
  return true;
}

// ---------------------------------------------------------------------------
// Enemy intents. Each intent "type" in data/enemies.json picks a handler here.
// Enemies cycle through their intents in order, so the next action is always known.

const INTENTS = {
  // "times" hits more than once; each hit picks its target again, in case the first one died.
  attack(combat, enemy, intent) {
    for (let hit = 0; hit < (intent.times ?? 1); hit++) {
      dealDamage(combat, { source: enemy.name, attacker: enemy, target: resolveEnemyTarget(enemy, combat), amount: intent.amount });
      if (checkOutcome(combat)) return;
    }
  },
  block: (combat, enemy, intent) => gainBlock(combat, enemy, intent.amount, enemy.name),
  status: (combat, enemy, intent) =>
    applyStatus(combat, combat.player, intent.status, { duration: intent.duration }, enemy.name),
  buffSelf: (combat, enemy, intent) => applyStatus(combat, enemy, intent.stat, { amount: intent.amount }, enemy.name),
  healAllies: (combat, enemy, intent) => {
    for (const ally of alliesOf(combat, enemy)) heal(combat, ally, intent.amount, enemy.name);
  },
  blockAllies: (combat, enemy, intent) => {
    for (const ally of alliesOf(combat, enemy)) gainBlock(combat, ally, intent.amount, enemy.name);
  },
  charge: (combat, enemy) => record(combat, { kind: 'info', text: `${enemy.name} winds up.` }),
  // A turn that does nothing, said in the data's own words.
  idle: (combat, enemy, intent) => record(combat, { kind: 'info', text: `${enemy.name}: ${intent.text}` }),
  // Burrowed until its side's next turn: it takes no damage while you act.
  burrow: (combat, enemy) => applyStatus(combat, enemy, 'burrowed', {}, enemy.name),
  // Eats a summon (picked by its targetPriority) and heals by the summon's HP. With no summons, it falls back.
  devourSummon(combat, enemy, intent) {
    const prey = resolveEnemyTarget(enemy, combat);
    if (prey.kind !== 'summon') return INTENTS[intent.fallback.type](combat, enemy, intent.fallback);
    const meal = prey.hp;
    destroy(combat, prey, `${enemy.name} devours ${prey.name}.`);
    heal(combat, enemy, meal, enemy.name);
  },
  summon: (combat, enemy, intent) => joinFight(combat, intent.id, intent.count ?? 1, { source: enemy.name }),
};

const currentIntent = (combat, enemy) => enemyDef(combat, enemy).intents[enemy.intentIndex];

// Conditions an intent can name in "requires". Until it holds, the enemy does the intent's "fallback".
const INTENT_REQUIREMENTS = {
  armorBroken: (combat, enemy) => !enemy.armor || enemy.armor.hitsLeft <= 0,
};

// The intent that will actually happen: a devour with nothing to eat becomes its fallback, and so does an
// intent whose "requires" doesn't hold yet (the crab can't call barnacles while they're still its armor).
// "taken" holds summons a timed ability removes first this turn, so a preview can look past them.
function effectiveIntent(combat, enemy, taken) {
  const intent = currentIntent(combat, enemy);
  if (intent.requires && !INTENT_REQUIREMENTS[intent.requires]?.(combat, enemy)) return intent.fallback;
  if (intent.type === 'devourSummon' && resolveEnemyTarget(enemy, combat, taken).kind !== 'summon') return intent.fallback;
  return intent;
}

// An enemy's turn: any timed ability that is due fires first, then its intent.
function actEnemy(combat, enemy) {
  const due = dueAbilities(combat, enemy);
  enemy.turns += 1;
  for (const ability of due) {
    record(combat, { kind: 'timed', name: ability.name, byUid: enemy.uid, byName: enemy.name });
    TIMED[ability.effect.type].act(combat, enemy, ability);
    if (checkOutcome(combat)) return;
  }
  const intent = effectiveIntent(combat, enemy);
  const act = INTENTS[intent.type];
  if (act) act(combat, enemy, intent);
  else record(combat, { kind: 'info', text: `${enemy.name} tries "${intent.type}", which isn't in the game yet.` });
  enemy.intentIndex = (enemy.intentIndex + 1) % enemyDef(combat, enemy).intents.length;
}

// Who an intent lands on, for the intent badge. Same functions the action itself uses.
const INTENT_TARGETS = {
  attack: (combat, enemy, taken) => resolveEnemyTarget(enemy, combat, taken),
  devourSummon: (combat, enemy, taken) => resolveEnemyTarget(enemy, combat, taken),
  status: (combat) => combat.player,
};

// What the intent badge shows: the intent's base numbers from data, plus who it will hit. When a timed
// ability takes a summon first (the beam), this enemy's intent, and those of enemies acting after it,
// target whoever is left.
export function intentPreview(combat, enemy) {
  const order = livingEnemies(combat);
  const actingFirst = order.slice(0, order.indexOf(enemy) + 1);
  const taken = new Set(actingFirst.flatMap((e) => timedPreview(combat, e)).filter((t) => t.due && t.takes).map((t) => t.takes));
  const intent = effectiveIntent(combat, enemy, taken);
  const target = INTENT_TARGETS[intent.type]?.(combat, enemy, taken);
  return { ...intent, targetName: target?.name, built: Boolean(INTENTS[intent.type]) };
}

// ---------------------------------------------------------------------------
// Timed abilities: something an enemy does every few of its own turns, on top of its intent
// (data/enemies.json "timedAbilities", "everyNTurns"). Telegraphed like an intent: a countdown until the
// turn it fires, then its target.

const TIMED = {
  // Corrupting Beam: steals the summon the enemy would target. It crosses over and fights for the enemy,
  // keeping its HP and attack; your other summons stay. Not a death: nothing that watches for a summon dying
  // fires, and if you kill it, it leaves no corpse. With no summon to take, the beam hits the player instead,
  // as an attack (Weak and Strength apply, block absorbs).
  stealSummon: {
    act(combat, enemy, ability) {
      const { effect } = ability;
      const victim = resolveEnemyTarget(enemy, combat);
      if (victim.kind !== 'summon') {
        dealDamage(combat, { source: ability.name, attacker: enemy, target: victim, amount: effect.fallbackDamageToPlayer });
      } else if (!effect.permanent) {
        destroy(combat, victim, `${ability.name} destroys ${victim.name}.`);
      } else {
        const thrall = turnSummon(combat, victim, enemy);
        record(combat, { kind: 'taken', source: ability.name, name: victim.name, thrall: thrall.name, byName: enemy.name });
      }
    },
    preview(combat, enemy, ability) {
      const victim = resolveEnemyTarget(enemy, combat);
      const takes = victim.kind === 'summon' ? victim.uid : null;
      return { targetName: victim.name, takes, amount: takes ? null : ability.effect.fallbackDamageToPlayer };
    },
  },
};

// The stolen summon leaves your side and stands beside its new master, with the HP it had and its attack.
function turnSummon(combat, summon, master) {
  const hp = summon.hp;
  summon.hp = 0;
  summon.taken = true;
  // Two stolen Skeletons are told apart by letter, like any twins.
  const base = `Corrupted ${summon.baseName ?? summon.name}`;
  const twins = livingEnemies(combat).filter((other) => other.def?.base === base);
  const used = new Set(twins.map((twin) => twin.name));
  const free = () => [...MARKS].map((mark) => `${base} ${mark}`).find((name) => !used.has(name));
  for (const twin of twins.filter((t) => t.name === base)) {
    twin.name = free();
    used.add(twin.name);
  }
  const name = twins.length ? free() : base;
  const thrall = {
    uid: nextUid('thrall'), id: summon.id, kind: 'enemy', name, hp, maxHp: summon.maxHp, block: 0, statuses: {},
    intentIndex: 0, turns: 0, splitDepth: 0, stolen: true,
    def: { id: summon.id, base, name: base, tier: 'minion', intents: [{ type: 'attack', amount: summon.attack }] },
  };
  combat.enemies.splice(combat.enemies.indexOf(master) + 1, 0, thrall);
  strengthen(combat, [thrall]);
  return thrall;
}

const builtTimed = (def) => (def.timedAbilities ?? []).filter((ability) => TIMED[ability.effect?.type]);

// How many more of its turns until the ability fires: 0 means on the enemy's coming turn.
const turnsUntil = (enemy, ability) => (ability.everyNTurns - ((enemy.turns + 1) % ability.everyNTurns)) % ability.everyNTurns;

const dueAbilities = (combat, enemy) => builtTimed(enemyDef(combat, enemy)).filter((ability) => turnsUntil(enemy, ability) === 0);

// What a timed ability's badge shows: its countdown, and on the turn it fires, what it will hit.
export function timedPreview(combat, enemy) {
  return builtTimed(enemyDef(combat, enemy)).map((ability) => {
    const inTurns = turnsUntil(enemy, ability);
    return { name: ability.name, inTurns, due: inTurns === 0, ...(inTurns === 0 ? TIMED[ability.effect.type].preview(combat, enemy, ability) : {}) };
  });
}

// ---------------------------------------------------------------------------
// Enemy passives: rules an enemy carries for the whole fight (data/enemies.json "passives").

const PASSIVES = {
  // Encrusted Armor: the first few attack hits of the fight are multiplied down. It counts hits, not damage,
  // so one huge hit can't strip it. Burn and other damage that isn't an attack neither counts nor shrinks.
  damageReduction: {
    setup(enemy, passive) {
      enemy.armor = { name: passive.name, multiplier: passive.multiplier, hits: passive.hitsRemaining, hitsLeft: passive.hitsRemaining };
    },
  },
  // Extract Confession: after each of its turns, shuffle a curse into the draw pile, unless "maxInDeck" of
  // the ones it added are already in your deck.
  addCurseEachTurn: {
    afterAct(combat, enemy, passive) {
      enemy.cursesAdded ??= [];
      const inDeck = Object.values(combat.piles).flat().filter((card) => enemy.cursesAdded.includes(card.uid)).length;
      if (passive.maxInDeck !== undefined && inDeck >= passive.maxInDeck) return;
      const curse = newCard(passive.curseId);
      enemy.cursesAdded.push(curse.uid);
      combat.piles.draw.push(curse);
      shuffle(combat.piles.draw);
      if (passive.persistsAfterFight) combat.gainedCurses.push(passive.curseId);
      record(combat, { kind: 'info', text: `${passive.name}: a ${combat.data.cardsById[passive.curseId].name} is shuffled into your draw pile.` });
    },
  },
  // Iron Maiden: ending your turn with energy left over costs you.
  punishUnspentEnergy: {
    onPlayerEndTurn(combat, enemy, passive) {
      if (combat.player.energy > 0) takeDamage(combat, combat.player, passive.damage, passive.name);
    },
  },
};

export const builtPassives = (def) => (def.passives ?? []).filter((passive) => PASSIVES[passive.type]);

function firePassives(combat, moment, enemies) {
  for (const enemy of enemies) {
    for (const passive of builtPassives(enemyDef(combat, enemy))) {
      PASSIVES[passive.type][moment]?.(combat, enemy, passive);
      if (checkOutcome(combat)) return true;
    }
  }
  return false;
}

function noteUnbuiltPassives(combat) {
  for (const enemy of combat.enemies) {
    const def = enemyDef(combat, enemy);
    const unbuilt = [...(def.passives ?? []).filter((p) => !PASSIVES[p.type]), ...(def.timedAbilities ?? []).filter((t) => !TIMED[t.effect?.type])];
    for (const ability of unbuilt) {
      record(combat, { kind: 'info', text: `${enemy.name}'s ${ability.name} isn't in the game yet.` });
    }
  }
}

// ---------------------------------------------------------------------------
// Companions' passives (data/companions.json), for the companions still with you in this fight.

export function companionPassives(combat, type) {
  return combat.companions
    .map((id) => combat.data.companionsById[id])
    .filter((companion) => companion?.passive.effect.type === type)
    .map((companion) => ({ ...companion.passive.effect, companion: companion.name }));
}

// The Pale Debtor: losing HP to your own cards heals you a little, and he collects from every enemy.
// His strike is his, not yours: your Strength and Weak don't touch it.
function ownLoss(combat, hpLost) {
  if (hpLost <= 0 || combat.player.hp <= 0) return;
  for (const passive of companionPassives(combat, 'onSelfDamage')) {
    if (passive.heal) heal(combat, combat.player, passive.heal, passive.companion);
    if (!passive.damageAllEnemies) continue;
    const debtor = { kind: 'companion', statuses: {} };
    for (const enemy of livingEnemies(combat)) {
      dealDamage(combat, { source: passive.companion, attacker: debtor, target: enemy, amount: passive.damageAllEnemies });
    }
    checkOutcome(combat);
  }
}

export function spendGold(combat, amount, source) {
  const before = combat.gold;
  combat.gold -= amount;
  record(combat, { kind: 'info', text: `${source}: pay ${amount} gold (${before} → ${combat.gold}).` });
}

// ---------------------------------------------------------------------------
// Damage math (SPEC: Damage Math). Exact order, rounding down at every step:
//   base, plus Strength, times the Weak multiplier if the attacker is Weak,
//   times the Marked multiplier if the target is Marked, minus the target's block.
// A companion's bonus to the card's base (Ashlin) comes first, before Strength. Armor (the crab's Encrusted
// Armor) multiplies after Marked, before block. A burrowed target takes nothing.

export function computeHit(amount, attacker, target, config, bonus) {
  const { weakMultiplier, markedMultiplier } = config.statusEffects;
  const afterBonus = amount + (bonus?.amount ?? 0);
  const strength = attacker.statuses.strength?.amount ?? 0;
  const afterStrength = Math.max(0, afterBonus + strength);
  const steps = [];
  let value = afterStrength;
  if (attacker.statuses.weak) {
    value = floorMul(value, weakMultiplier);
    steps.push({ label: 'Weak', multiplier: weakMultiplier, value });
  }
  if (target.statuses.marked) {
    value = floorMul(value, markedMultiplier);
    steps.push({ label: 'Marked', multiplier: markedMultiplier, value });
  }
  if (target.armor?.hitsLeft > 0) {
    value = floorMul(value, target.armor.multiplier);
    steps.push({ label: target.armor.name, multiplier: target.armor.multiplier, value, armor: true });
  }
  if (target.statuses.burrowed) {
    value = 0;
    steps.push({ label: 'Burrowed', immune: true, value });
  }
  const blocked = Math.min(target.block, value);
  return { base: amount, bonus, afterBonus, strength, afterStrength, steps, blocked, damage: value - blocked };
}

// "damage" is what got past block; "hpLost" is what the target actually lost, which is less when the hit
// overkills. Call Your Shot is judged on hpLost.
function applyHit(combat, target, hit, entry) {
  const hpBefore = target.hp;
  target.block -= hit.blocked;
  target.hp = Math.max(0, target.hp - hit.damage);
  const result = { ...hit, hpBefore, hpAfter: target.hp, hpLost: hpBefore - target.hp };
  record(combat, { kind: 'hit', ...entry, targetUid: target.uid, targetName: target.name, ...result, blockAfter: target.block });
  if (hpBefore > 0 && target.hp <= 0) onDeath(combat, target);
  return result;
}

// An attack: a companion's bonus, Strength, Weak and Marked apply. "detail" explains where the base came from.
export function dealDamage(combat, { source, attacker, target, amount, bonus, detail }) {
  if (target.hp <= 0) return { damage: 0, hpLost: 0, blocked: 0 };
  const hit = computeHit(amount, attacker, target, combat.data.config, bonus);
  const result = applyHit(combat, target, hit, { source, attackerKind: attacker.kind, detail });
  if (hit.steps.some((step) => step.armor)) wearArmor(combat, target);
  return result;
}

// Every hit the armor softened knocks a barnacle off. At zero the armor is gone for the rest of the fight.
function wearArmor(combat, enemy) {
  enemy.armor.hitsLeft -= 1;
  record(combat, { kind: 'armor', name: enemy.armor.name, targetName: enemy.name, hitsLeft: enemy.armor.hitsLeft });
}

// Damage that isn't an attack (Burn, Darkhold Pact, Iron Maiden): only block reduces it.
// "own" marks damage from your own cards (Darkhold Pact), which the Pale Debtor answers.
export function takeDamage(combat, target, amount, source, { own } = {}) {
  if (target.hp <= 0) return { damage: 0, hpLost: 0, blocked: 0 };
  const value = target.statuses.burrowed ? 0 : amount;
  const steps = target.statuses.burrowed ? [{ label: 'Burrowed', immune: true, value }] : [];
  const blocked = Math.min(target.block, value);
  const hit = applyHit(combat, target, { base: amount, strength: 0, afterStrength: amount, steps, blocked, damage: value - blocked }, { source, attackerKind: 'none' });
  if (own && target === combat.player) ownLoss(combat, hit.hpLost);
  return hit;
}

// Losing HP is not damage: block doesn't absorb it. "own" marks HP lost to your own cards.
export function loseHealth(combat, unit, amount, source, { own } = {}) {
  const before = unit.hp;
  unit.hp = Math.max(0, unit.hp - amount);
  record(combat, { kind: 'lose', source, targetName: unit.name, amount, before, after: unit.hp });
  if (before > 0 && unit.hp <= 0) onDeath(combat, unit);
  if (own && unit === combat.player) ownLoss(combat, before - unit.hp);
}

// Paying health is a cost, not damage. Callers keep you above 0.
export function payHealth(combat, amount, source) {
  const { player } = combat;
  const before = player.hp;
  player.hp -= amount;
  record(combat, { kind: 'pay', source, amount, before, after: player.hp });
  ownLoss(combat, amount);
}

export function loseMaxHealth(combat, amount, source) {
  const { player } = combat;
  const before = player.maxHp;
  player.maxHp = Math.max(0, player.maxHp - amount);
  player.hp = Math.min(player.hp, player.maxHp);
  record(combat, { kind: 'maxhp', source, amount, before, after: player.maxHp });
  if (player.hp <= 0) onDeath(combat, player);
}

// Block gained, reduced by Frail. "persists" block survives the next start-of-turn reset.
export function gainBlock(combat, unit, amount, source, { persists, detail } = {}) {
  const { frailMultiplier } = combat.data.config.statusEffects;
  const steps = [];
  let gained = amount;
  if (unit.statuses.frail) {
    gained = floorMul(gained, frailMultiplier);
    steps.push({ label: 'Frail', multiplier: frailMultiplier, value: gained });
  }
  const before = unit.block;
  unit.block += gained;
  if (persists) unit.blockKept += gained;
  record(combat, { kind: 'block', source, targetName: unit.name, base: amount, detail, steps, gained, before, after: unit.block, persists });
}

export function heal(combat, unit, amount, source) {
  const before = unit.hp;
  unit.hp = Math.min(unit.maxHp, unit.hp + amount);
  record(combat, { kind: 'heal', source, targetName: unit.name, amount, before, after: unit.hp });
}

export function gainEnergy(combat, amount, source) {
  combat.player.energy += amount;
  record(combat, { kind: 'info', text: `${source}: +${amount} energy.` });
}

// Removes a creature outright (devoured, sacrificed, pushed off a full board).
export function destroy(combat, unit, text) {
  if (unit.hp <= 0) return;
  unit.hp = 0;
  record(combat, { kind: 'info', text });
  onDeath(combat, unit);
}

// A dead enemy leaves a corpse Reanimate can raise, and may split. A dead summon fires powers that
// watch for it (Second Death) and leaves nothing.
function onDeath(combat, unit) {
  record(combat, { kind: 'death', name: unit.name, unitKind: unit.kind });
  if (unit.kind === 'enemy') {
    combat.kills += 1;
    if (!unit.stolen) combat.corpses.push(unit); // a stolen summon is gone for good
    splitOnDeath(combat, unit);
    if (enemyDef(combat, unit).fightEndsOnDeath) endsWith(combat, unit);
  }
  if (unit.kind === 'summon') firePowers(combat, 'summonDeath');
}

// A boss (data "fightEndsOnDeath") takes the fight with it: whatever fought beside it falls too.
function endsWith(combat, leader) {
  const left = livingEnemies(combat);
  if (!left.length) return;
  record(combat, { kind: 'info', text: `With ${leader.name} dead, the fight is over.` });
  for (const enemy of left) destroy(combat, enemy, `${enemy.name} falls with ${leader.name}.`);
}

// Blood Blob: splits into smaller enemies, until its split depth reaches maxSplitDepth.
function splitOnDeath(combat, enemy) {
  const split = enemyDef(combat, enemy).onDeath;
  if (split?.type !== 'split' || enemy.splitDepth >= split.maxSplitDepth) return;
  joinFight(combat, split.into, split.count, { after: enemy, splitDepth: enemy.splitDepth + 1, source: enemy.name });
}

// ---------------------------------------------------------------------------
// Status effects. Re-applying a status adds to its duration; Strength amounts add (negative lowers attack);
// Burn keeps the larger amount. A status with a duration counts down at the start of the player's turn
// and is removed when it runs out. One applied during the enemy turn skips that next count, so
// "Weak 2" from an enemy lasts two of your turns. A status without a duration (Strength) lasts the fight.

export function applyStatus(combat, unit, name, { duration, amount }, source) {
  const status = unit.statuses[name] ?? (unit.statuses[name] = {});
  if (duration !== undefined) status.duration = (status.duration ?? 0) + duration;
  if (amount !== undefined) {
    status.amount = name === 'burn' ? Math.max(status.amount ?? 0, amount) : (status.amount ?? 0) + amount;
  }
  if (combat.phase !== 'player') status.fresh = true;
  if (status.amount === 0 && status.duration === undefined) delete unit.statuses[name];
  record(combat, { kind: 'status', source, targetName: unit.name, name, duration, amount });
}

function tickStatuses(units) {
  for (const unit of units) {
    for (const [name, status] of Object.entries(unit.statuses)) {
      if (status.duration === undefined) continue;
      if (status.fresh) {
        delete status.fresh;
        continue;
      }
      status.duration -= 1;
      if (status.duration <= 0) delete unit.statuses[name];
    }
  }
}

// ---------------------------------------------------------------------------
// Piles

function drawTo(combat, handSize) {
  const { piles } = combat;
  while (piles.hand.length < handSize) {
    if (!piles.draw.length) {
      if (!piles.discard.length) return;
      piles.draw = shuffle(piles.discard);
      piles.discard = [];
      record(combat, { kind: 'info', text: 'Discard pile shuffled into the draw pile.' });
    }
    piles.hand.push(piles.draw.pop());
  }
}

export function drawCards(combat, count, source) {
  drawTo(combat, combat.piles.hand.length + count);
  record(combat, { kind: 'info', text: `${source}: draw ${count}.` });
}

// Cards marked "retain" (Dead Weight) stay in hand.
function discardHand(combat) {
  const retained = combat.piles.hand.filter((instance) => resolveCard(combat.data, instance).retain);
  combat.piles.discard.push(...combat.piles.hand.filter((instance) => !retained.includes(instance)));
  combat.piles.hand = retained;
}

export function record(combat, entry) {
  combat.log.push(entry);
}
