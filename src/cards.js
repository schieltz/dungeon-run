// Card effect dispatcher.
// A card's "effects" list in data/cards.json runs top to bottom, and each effect's "type" picks a handler below.
// A new card built from existing keywords is a data change only. A new keyword is one new entry in EFFECTS.

import {
  applyStatus, checkOutcome, companionPassives, dealDamage, drawCards, gainBlock, gainEnergy, heal, livingEnemies,
  loseHealth, loseMaxHealth, payHealth, record, scheduleEndOfTurn, spendGold,
} from './combat.js';
import { buffSummons, consumeSummon, livingSummons, raiseCorpse, raiseEveryCorpse, summonFromType } from './summons.js';
import { floorMul, newCard, pickOne, pickWeighted } from './state.js';

// ---------------------------------------------------------------------------
// Card definitions. An upgraded card takes its text and effects from the card's "upgrade" entry.

export function resolveCard(data, instance) {
  const def = data.cardsById[instance.id];
  if (!instance.upgraded || !def.upgrade) return def;
  return { ...def, ...def.upgrade, name: `${def.name}+` };
}

export const cardDef = (combat, instance) => resolveCard(combat.data, instance);
export const canUpgrade = (data, instance) => !instance.upgraded && Boolean(data.cardsById[instance.id].upgrade);

// ---------------------------------------------------------------------------
// Effect targets. "enemy" is the one the player tapped; the others need no tap.

const TARGETS = {
  enemy: (ctx) => (ctx.target?.kind === 'enemy' && ctx.target.hp > 0 ? [ctx.target] : []),
  allEnemies: (ctx) => livingEnemies(ctx.combat),
  randomEnemy: (ctx) => {
    const enemies = livingEnemies(ctx.combat);
    return enemies.length ? [pickOne(enemies)] : [];
  },
  self: (ctx) => [ctx.combat.player],
};
const targetsOf = (ctx, effect) => TARGETS[effect.target](ctx);

// A stat an effect can lower on an enemy, and the status that carries it.
const STAT_STATUSES = { attack: 'strength' };

// Effects that hit one enemy without saying so in a "target" field.
const AIMED = { goldenLight: 'enemy' };
const aimOf = (effect) => effect.target ?? AIMED[effect.type];

// A companion's bonus to a school's damage (Ashlin the Ember), for the card being played.
function schoolBonus(ctx) {
  const school = ctx.card?.school;
  const passives = companionPassives(ctx.combat, 'schoolDamageBonus').filter((p) => p.school === school);
  const amount = passives.reduce((sum, p) => sum + p.amount, 0);
  return amount ? { amount, label: passives.map((p) => p.companion).join(', ') } : undefined;
}

const EFFECTS = {
  // "times" repeats the whole effect: every target is hit once, then again. "lifesteal" heals that
  // fraction of the HP the hit took, rounded down.
  damage(ctx, effect) {
    for (let wave = 0; wave < (effect.times ?? 1); wave++) {
      for (const target of targetsOf(ctx, effect)) {
        const hit = dealDamage(ctx.combat, { source: ctx.source, attacker: ctx.combat.player, target, amount: effect.amount, bonus: schoolBonus(ctx) });
        if (effect.lifesteal) heal(ctx.combat, ctx.combat.player, floorMul(hit.damage, effect.lifesteal), ctx.source);
      }
    }
  },
  block: (ctx, effect) => gainBlock(ctx.combat, ctx.combat.player, effect.amount, ctx.source, { persists: effect.persists }),
  heal: (ctx, effect) => heal(ctx.combat, ctx.combat.player, effect.amount, ctx.source),
  status: (ctx, effect) => {
    const duration = effect.duration ?? ctx.combat.data.config.statusEffects.defaultDuration;
    for (const target of targetsOf(ctx, effect)) {
      applyStatus(ctx.combat, target, effect.status, { duration, amount: effect.amount }, ctx.source);
    }
  },
  // A stat raised on yourself for the rest of the fight (a relic's Strength). No duration: it lasts.
  buffSelf: (ctx, effect) => applyStatus(ctx.combat, ctx.combat.player, effect.stat, { amount: effect.amount }, ctx.source),
  // Lowering an enemy's attack for the fight is negative Strength, so it shows and resolves the same way.
  debuffStat: (ctx, effect) => {
    for (const target of targetsOf(ctx, effect)) {
      applyStatus(ctx.combat, target, STAT_STATUSES[effect.stat], { amount: -effect.amount }, ctx.source);
    }
  },
  loseHealth: (ctx, effect) => loseHealth(ctx.combat, ctx.combat.player, effect.amount, ctx.source, { own: true }),
  loseMaxHealth: (ctx, effect) => loseMaxHealth(ctx.combat, effect.amount, ctx.source),
  draw: (ctx, effect) => drawCards(ctx.combat, effect.amount, ctx.source),
  energy: (ctx, effect) => gainEnergy(ctx.combat, effect.amount, ctx.source),
  delayedDamage: (ctx, effect) => scheduleEndOfTurn(ctx.combat, effect.amount, ctx.source),
  addRandomCard: (ctx, effect) => {
    const [id] = rollCards(ctx.combat.data, 1, { rarity: effect.rarity });
    if (!id) return;
    ctx.combat.piles.hand.push(newCard(id));
    record(ctx.combat, { kind: 'info', text: `${ctx.source}: ${ctx.combat.data.cardsById[id].name} added to your hand.` });
  },
  // "count" is how many to summon; a card that doesn't say summons one.
  summon: (ctx, effect) =>
    Array.from({ length: effect.count ?? 1 }, () => summonFromType(ctx.combat, effect.id, ctx.source)),
  // Multipliers come from the card (the upgrade raises hpMultiplier), falling back to config.json "reanimate".
  reanimate: (ctx, effect) => {
    const defaults = ctx.combat.data.config.reanimate;
    raiseCorpse(ctx.combat, {
      payment: ctx.payment,
      hpMultiplier: effect.hpMultiplier ?? defaults.hpMultiplier,
      attackMultiplier: effect.attackMultiplier ?? defaults.attackMultiplier,
      source: ctx.source,
    });
  },
  // Golden Light: pay gold and X health, deal X times damagePerHealth to one enemy. The health is paid up front.
  // Costs come from the card, falling back to config.json "goldenLight".
  goldenLight: (ctx, effect) => {
    const defaults = ctx.combat.data.config.goldenLight;
    const perHealth = effect.damagePerHealth ?? defaults.damagePerHealthPaid;
    spendGold(ctx.combat, effect.goldCost ?? defaults.goldCost, ctx.source);
    dealDamage(ctx.combat, {
      source: ctx.source, attacker: ctx.combat.player, target: ctx.target, bonus: schoolBonus(ctx),
      amount: floorMul(ctx.payment, perHealth), detail: `${ctx.payment} health × ${perHealth}`,
    });
  },
  // Companion sacrifices (data/companions.json).
  healFull: (ctx) => heal(ctx.combat, ctx.combat.player, ctx.combat.player.maxHp - ctx.combat.player.hp, ctx.source),
  raiseAllCorpses: (ctx) => raiseEveryCorpse(ctx.combat, ctx.source),
  removeAllCurses: (ctx) => {
    const { combat } = ctx;
    const clean = (pile) => pile.filter((instance) => !combat.data.curseIds.has(instance.id));
    for (const name of Object.keys(combat.piles)) combat.piles[name] = clean(combat.piles[name]);
    combat.gainedCurses = [];
    combat.cleansed = true;
    record(combat, { kind: 'info', text: `${ctx.source}: every curse is gone from your deck.` });
  },
  buffSummons: (ctx, effect) => buffSummons(ctx.combat, effect.stat, effect.amount, ctx.source),
  blockPerSummon: (ctx, effect) => {
    const count = livingSummons(ctx.combat).length;
    gainBlock(ctx.combat, ctx.combat.player, effect.amount * count, ctx.source, { detail: `${effect.amount} × ${count} summons` });
  },
  consumeSummon: (ctx) => consumeSummon(ctx.combat, ctx.target, ctx.source),
  // A power stays in play for the rest of the fight and fires its effect whenever its trigger happens.
  power: (ctx, effect) => {
    ctx.combat.powers.push({ trigger: effect.trigger, effect: effect.effect, source: ctx.source });
    record(ctx.combat, { kind: 'info', text: `${ctx.source} takes hold for the rest of the fight.` });
  },
};

// Effects that come from something other than a card in hand: a relic or an event's lasting effect at the
// start of a fight. They act as you, and anything aimed at one creature lands on you.
export function applyEffects(combat, effects, source) {
  for (const effect of effects.filter(effectBuilt)) EFFECTS[effect.type]({ combat, source, target: combat.player }, effect);
}

const effectBuilt = (effect) =>
  Boolean(EFFECTS[effect.type]) &&
  (!aimOf(effect) || Boolean(TARGETS[aimOf(effect)])) &&
  (effect.type !== 'debuffStat' || Boolean(STAT_STATUSES[effect.stat])) &&
  (effect.type !== 'power' || effectBuilt(effect.effect));

export const isBuilt = (card) => (card.effects ?? []).every(effectBuilt);

function runEffects(combat, effects, ctx) {
  for (const effect of effects) EFFECTS[effect.type]({ combat, ...ctx }, effect);
}

// Powers in play whose trigger just happened fire their effect.
export function firePowers(combat, trigger) {
  for (const power of combat.powers.filter((p) => p.trigger === trigger)) {
    runEffects(combat, [power.effect], { source: power.source, target: null });
  }
}

// ---------------------------------------------------------------------------
// Card "requires" conditions, written in data as "name" or "name:value" (e.g. "corpseAvailable", or "gold:" followed by an amount).

const REQUIREMENTS = {
  corpseAvailable: {
    met: (combat) => combat.corpses.length > 0,
    reason: () => 'No corpse to raise.',
  },
  gold: {
    met: (combat, value) => combat.gold >= Number(value),
    reason: (value) => `Needs ${value} gold.`,
  },
};

function unmetRequirement(combat, card) {
  if (!card.requires) return null;
  const [name, value] = card.requires.split(':');
  const requirement = REQUIREMENTS[name];
  if (!requirement) return 'Not in the game yet.';
  return requirement.met(combat, value) ? null : requirement.reason(value);
}

// ---------------------------------------------------------------------------
// Targeting. "enemy": tap an enemy. "summon": tap one of your summons. "all": hits without aiming; tap
// any enemy or the card again. "self": tap yourself or the card again.

export function targetMode(card) {
  const effects = card.effects ?? [];
  if (effects.some((effect) => aimOf(effect) === 'enemy')) return 'enemy';
  if (effects.some((effect) => effect.type === 'consumeSummon')) return 'summon';
  if (effects.some((effect) => aimOf(effect))) return 'all';
  return 'self';
}

const PROMPTS = {
  enemy: (name) => `Tap an enemy to cast ${name}.`,
  summon: (name) => `Tap one of your summons to cast ${name}.`,
  all: (name) => `Tap any enemy, or the card again, to cast ${name}.`,
  self: (name) => `Tap yourself, or the card again, to cast ${name}.`,
};
export const targetPrompt = (card) => PROMPTS[targetMode(card)](card.name);

function pickTarget(combat, card, targetUid) {
  const mode = targetMode(card);
  if (mode === 'enemy') return livingEnemies(combat).find((enemy) => enemy.uid === targetUid);
  if (mode === 'summon') return livingSummons(combat).find((summon) => summon.uid === targetUid);
  const onEnemy = livingEnemies(combat).some((enemy) => enemy.uid === targetUid);
  if (mode === 'all' && onEnemy) return combat.player;
  return targetUid === combat.player.uid ? combat.player : null;
}

// ---------------------------------------------------------------------------
// Playing a card

const blocked = (kind, reason) => ({ ok: false, kind, reason });

// "Pay X health" cards: the player chooses X before casting. X is a whole number of at least one,
// and must leave the player standing.
export const needsPayment = (card) => (card.effects ?? []).some((effect) => effect.variableHealthCost);
export const paymentRange = (combat) => ({ min: 1, max: combat.player.hp - 1 });

export function playability(combat, card) {
  if (combat.phase !== 'player') return blocked('turn', 'Wait for your turn.');
  if (card.unplayable || card.cost == null) return blocked('unplayable', "This card can't be played.");
  const unmet = unmetRequirement(combat, card);
  if (unmet) return blocked('requires', unmet);
  if (!isBuilt(card)) return blocked('unbuilt', 'Not in the game yet.');
  if (targetMode(card) === 'summon' && !livingSummons(combat).length) return blocked('requires', 'You have no summons.');
  if (needsPayment(card)) {
    const { min, max } = paymentRange(combat);
    if (max < min) return blocked('health', 'Not enough health to pay.');
  }
  if (card.cost > combat.player.energy) return blocked('energy', 'Not enough energy.');
  return { ok: true };
}

export function playCard(combat, cardUid, targetUid, payment, call) {
  const instance = combat.piles.hand.find((c) => c.uid === cardUid);
  if (!instance) return blocked('missing', 'That card is not in your hand.');
  const card = cardDef(combat, instance);
  const check = playability(combat, card);
  if (!check.ok) return check;
  const target = pickTarget(combat, card, targetUid);
  if (!target) return blocked('target', targetPrompt(card));
  if (needsPayment(card)) {
    const { min, max } = paymentRange(combat);
    if (!Number.isInteger(payment) || payment < min || payment > max) {
      return blocked('payment', `Choose how much health to pay, from ${min} to ${max}.`);
    }
  }

  combat.player.energy -= card.cost;
  combat.piles.hand = combat.piles.hand.filter((c) => c !== instance);
  if (needsPayment(card)) payHealth(combat, payment, card.name);
  const logStart = combat.log.length;
  runEffects(combat, card.effects, { card, source: card.name, target, payment });
  if (call !== undefined && canCallShot(card)) judgeCall(combat, card, target, call, logStart);

  // Where the card goes: exhausted cards leave for the fight, powers stay in play, the rest are discarded.
  if (card.exhaust) combat.piles.exhaust.push(instance);
  else if (!card.effects.some((effect) => effect.type === 'power')) combat.piles.discard.push(instance);
  checkOutcome(combat);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The card pool: what rewards and the shop can offer. Every rarity with a weight in config.json
// "rewards.rarityWeights", and only cards whose keywords are all built.

export const cardPool = (data, rarity) => data.cards.cards.filter((card) => card.rarity === rarity && isBuilt(card));

// Up to `count` different card ids, each rarity picked by weight. `rarity` limits it to one rarity;
// `weights` swaps in other odds (an elite's better cards).
export function rollCards(data, count, { rarity, weights: odds } = {}) {
  const weights = rarity ? { [rarity]: 1 } : odds ?? data.config.rewards.rarityWeights;
  const picked = [];
  while (picked.length < count) {
    const remaining = (r) => cardPool(data, r).filter((card) => !picked.includes(card.id));
    const open = Object.fromEntries(Object.entries(weights).filter(([r]) => !r.startsWith('_') && remaining(r).length));
    const chosen = pickWeighted(open);
    if (!chosen) break;
    picked.push(pickOne(remaining(chosen)).id);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Call Your Shot (SPEC: Call Your Shot). Before an attack on one enemy, the player may predict the HP it
// will take. Exactly right pays config.json "callYourShot.rewardEnergy" at the start of next turn, at most
// "maxBonusesPerTurn" times a turn. Wrong costs nothing.

export const canCallShot = (card) =>
  targetMode(card) === 'enemy' && (card.effects ?? []).some((effect) => ['damage', 'goldenLight'].includes(effect.type));

function judgeCall(combat, card, target, call, logStart) {
  const { rewardEnergy, maxBonusesPerTurn } = combat.data.config.callYourShot;
  const actual = combat.log.slice(logStart)
    .filter((entry) => entry.kind === 'hit' && entry.targetUid === target.uid && entry.attackerKind === 'player')
    .reduce((sum, entry) => sum + entry.hpLost, 0);
  const exact = call === actual;
  const paid = exact && combat.shot.bonuses < maxBonusesPerTurn;
  if (paid) {
    combat.shot.bonuses += 1;
    combat.shot.energyNextTurn += rewardEnergy;
  }
  record(combat, { kind: 'call', source: card.name, call, actual, exact, paid, reward: rewardEnergy });
  return { exact, paid };
}

// ---------------------------------------------------------------------------
// A companion's sacrifice in a fight: one large effect, then the companion is gone for good.

export function sacrificeInFight(combat, id) {
  const companion = combat.data.companionsById[id];
  if (combat.phase !== 'player' || !combat.companions.includes(id)) return blocked('turn', 'Not now.');
  combat.companions = combat.companions.filter((c) => c !== id);
  record(combat, { kind: 'info', text: `${companion.name} is sacrificed: ${companion.sacrifice.name}.` });
  runEffects(combat, companion.sacrifice.effects, { source: companion.sacrifice.name, target: null });
  checkOutcome(combat);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// What changes a card's numbers right now, shown on the card beside its base text (never combined into a
// final number: SPEC says the player does that math).

export function cardModifiers(combat, card) {
  const { statusEffects } = combat.data.config;
  const { player } = combat;
  const effects = card.effects ?? [];
  const hits = effects.some((effect) => ['damage', 'goldenLight'].includes(effect.type));
  const blocks = effects.some((effect) => ['block', 'blockPerSummon'].includes(effect.type));
  const mods = [];
  if (hits) {
    const bonus = schoolBonus({ combat, card });
    if (bonus) mods.push(`+${bonus.amount} ${bonus.label}`);
    const strength = player.statuses.strength?.amount;
    if (strength) mods.push(`${strength > 0 ? '+' : '−'}${Math.abs(strength)} Strength`);
    if (player.statuses.weak) mods.push(`×${statusEffects.weakMultiplier} Weak`);
  }
  if (blocks && player.statuses.frail) mods.push(`×${statusEffects.frailMultiplier} Frail`);
  if (effects.some((effect) => ['summon', 'reanimate'].includes(effect.type))) {
    for (const p of companionPassives(combat, 'summonBonus')) {
      const gains = [p.hp && `+${p.hp} HP`, p.attack && `+${p.attack} attack`, p.stat && `+${p.amount} ${p.stat.toUpperCase()}`].filter(Boolean);
      mods.push(`${gains.join(' ')} ${p.companion}`);
    }
  }
  return mods;
}
