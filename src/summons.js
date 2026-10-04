// Summons: summon lifecycle and targeting (SPEC: Summons).
//
// Summons fight for you for one fight. They act after you and before the enemies, in the order
// they were summoned, each attacking its assigned target. They die at 0 HP and vanish when the
// fight ends (they live only in the combat state). The board holds config.run.maxSummons;
// summoning past that replaces the oldest.

import { companionPassives, dealDamage, destroy, enemyDef, livingEnemies, MARKS, record } from './combat.js';
import { floorMul, nextUid } from './state.js';

export const livingSummons = (combat) => combat.summons.filter((summon) => summon.hp > 0);

// ---------------------------------------------------------------------------
// Enemy targeting. Deterministic, never random (SPEC: Enemy targeting rule):
//   if any summon is alive, an enemy attacks the summon with the highest current HP; otherwise the player.
//   "ignoresSummons": true always attacks the player. "targetPriority" in an enemy's data can pick differently.
// Ties go to the oldest summon, so the target is always knowable in advance.

const SUMMON_PRIORITIES = {
  highestHpSummon: (summons) => summons.reduce((best, summon) => (summon.hp > best.hp ? summon : best)),
  lowestHpSummon: (summons) => summons.reduce((best, summon) => (summon.hp < best.hp ? summon : best)),
};

// Who an enemy's intent will hit. The intent badge and the attack itself both ask this function,
// so the target shown before the player acts is the target that gets hit. "taken" (uids) are summons
// that will be gone by then (the crab's beam fires before its intent).
export function resolveEnemyTarget(enemy, combat, taken) {
  const def = enemyDef(combat, enemy);
  const summons = livingSummons(combat).filter((summon) => !taken?.has(summon.uid));
  if (def.ignoresSummons || !summons.length) return combat.player;
  const pick = SUMMON_PRIORITIES[def.targetPriority] ?? SUMMON_PRIORITIES.highestHpSummon;
  return pick(summons);
}

// ---------------------------------------------------------------------------
// Summon targeting. Each summon attacks its assigned enemy: the leftmost by default,
// or whichever one the player assigned by tapping the summon and then the enemy.
// If its target has died it moves to the leftmost enemy still standing.

export function summonTarget(combat, summon) {
  const enemies = livingEnemies(combat);
  const [leftmost] = enemies;
  return enemies.find((enemy) => enemy.uid === summon.targetUid) ?? leftmost;
}

export function assignSummonTarget(combat, summonUid, enemyUid) {
  const summon = livingSummons(combat).find((s) => s.uid === summonUid);
  const enemy = livingEnemies(combat).find((e) => e.uid === enemyUid);
  if (combat.phase !== 'player' || !summon || !enemy) return false;
  summon.targetUid = enemy.uid;
  return true;
}

// What a summon's intent badge shows: its attack and its target. Summons with no attack show nothing.
export function summonIntentPreview(combat, summon) {
  if (!summon.attack) return null;
  return { type: 'attack', amount: summon.attack, targetName: summonTarget(combat, summon)?.name };
}

// ---------------------------------------------------------------------------
// Lifecycle

// What companions add to every summon (Grave-Tender Mol): { hp, attack }.
export function summonBonus(combat) {
  const passives = companionPassives(combat, 'summonBonus');
  const total = (stat) => passives.reduce((sum, p) => sum + (p[stat] ?? (p.stat === stat ? p.amount : 0)), 0);
  return { hp: total('hp'), attack: total('attack') };
}

// Every summon enters with any bonus a companion gives (Grave-Tender Mol).
function addSummon(combat, { id, name: baseName, hp: baseHp, attack: baseAttack }) {
  const bonus = summonBonus(combat);
  const hp = baseHp + bonus.hp;
  const attack = baseAttack + bonus.attack;
  const alive = livingSummons(combat);
  if (alive.length >= combat.data.config.run.maxSummons) {
    const [oldest] = alive;
    destroy(combat, oldest, `${oldest.name} crumbles to make room.`);
  }
  const summon = {
    uid: nextUid('summon'), id, kind: 'summon', baseName, name: markSummon(combat, baseName),
    hp, maxHp: hp, block: 0, statuses: {}, attack, targetUid: null,
  };
  const gains = [bonus.hp && `+${bonus.hp} HP`, bonus.attack && `+${bonus.attack} attack`].filter(Boolean);
  if (gains.length) record(combat, { kind: 'info', text: `${summon.name} enters with ${gains.join(' and ')}.` });
  combat.summons.push(summon);
  return summon;
}

// Two living summons with the same name are told apart by letter, like enemies, so an intent's target
// ("→ Skeleton B") is never ambiguous. The one already standing takes the first letter when its twin arrives.
function markSummon(combat, baseName) {
  const twins = livingSummons(combat).filter((summon) => summon.baseName === baseName);
  if (!twins.length) return baseName;
  const used = new Set(twins.map((twin) => twin.name));
  const free = () => [...MARKS].map((mark) => `${baseName} ${mark}`).find((name) => !used.has(name));
  for (const twin of twins.filter((t) => t.name === baseName)) {
    used.delete(baseName);
    twin.name = free();
    used.add(twin.name);
  }
  return free();
}

// A summon from data/enemies.json "summonTypes" (Raise Skeleton, Corpse Wall).
export function summonFromType(combat, typeId, source) {
  const type = combat.data.summonTypesById[typeId];
  const summon = addSummon(combat, { id: type.id, name: type.name, hp: type.hp, attack: type.attack });
  record(combat, { kind: 'summon', source, name: summon.name, hp: summon.hp, attack: summon.attack });
}

// The attack a raised enemy started from: "attackForReanimate" if its data names one,
// otherwise its hardest single hit.
function originalAttack(def) {
  if (def.attackForReanimate !== undefined) return def.attackForReanimate;
  const hits = def.intents.filter((intent) => intent.type === 'attack').map((intent) => intent.amount);
  return hits.length ? Math.max(...hits) : 0;
}

// Reanimate: raise the last enemy that died this fight. The corpse is used up.
// HP is the health paid times hpMultiplier; attack is its original attack times attackMultiplier,
// rounded down. Both multipliers come from the card's data.
// Open the Graves: every enemy that died this fight rises, oldest first, at its full HP and with the same
// share of its attack Reanimate gives (config.json "reanimate.attackMultiplier"). The board cap still holds.
export function raiseEveryCorpse(combat, source) {
  const { attackMultiplier } = combat.data.config.reanimate;
  for (const corpse of combat.corpses.splice(0)) {
    const def = combat.data.enemiesById[corpse.id];
    const baseAttack = originalAttack(def);
    const attack = floorMul(baseAttack, attackMultiplier);
    const summon = addSummon(combat, { id: def.id, name: `Risen ${def.name}`, hp: corpse.maxHp, attack });
    record(combat, { kind: 'summon', source, name: summon.name, hp: summon.hp, attack: summon.attack });
  }
}

export function raiseCorpse(combat, { payment, hpMultiplier, attackMultiplier, source }) {
  const corpse = combat.corpses.pop();
  const def = combat.data.enemiesById[corpse.id];
  const baseAttack = originalAttack(def);
  const hp = floorMul(payment, hpMultiplier);
  const attack = floorMul(baseAttack, attackMultiplier);
  const summon = addSummon(combat, { id: def.id, name: `Risen ${def.name}`, hp, attack });
  record(combat, {
    kind: 'raise', source, corpseName: corpse.name, name: summon.name,
    payment, hpMultiplier, hp, baseAttack, attackMultiplier, attack,
  });
}

// Bolster, Marrow Shield: every living summon gains attack or HP for the fight.
export function buffSummons(combat, stat, amount, source) {
  const summons = livingSummons(combat);
  for (const summon of summons) {
    if (stat === 'hp') {
      summon.hp += amount;
      summon.maxHp += amount;
    } else {
      summon.attack += amount;
    }
  }
  if (summons.length) record(combat, { kind: 'info', text: `${source}: your summons gain +${amount} ${stat === 'hp' ? 'HP' : 'attack'}.` });
}

// Grave Harvest: destroy one of your summons and hurl it at its target, dealing damage equal to its HP.
export function consumeSummon(combat, summon, source) {
  const target = summonTarget(combat, summon);
  const amount = summon.hp;
  destroy(combat, summon, `${source}: ${summon.name} is consumed.`);
  if (target) dealDamage(combat, { source, attacker: combat.player, target, amount });
}
