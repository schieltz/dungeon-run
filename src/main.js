// Boot and screen router.
// Loads /data, checks it, applies the theme, and wires taps to the game. The whole game state lives in
// `app` and is saved after every redraw, so a reloaded tab picks up exactly where it was.

import { applyPalette, renderBootError, renderScreen } from './render.js';
import { catchUpEnemies, createCombat, endPlayerTurn, freezeCombat, livingEnemies, thawCombat } from './combat.js';
import { canCallShot, cardDef, needsPayment, paymentRange, playability, playCard, sacrificeInFight, targetMode } from './cards.js';
import { assignSummonTarget, livingSummons } from './summons.js';
import { claimRewards, currentNode, enterNode, FIGHT_TYPES, generateMap, settleFight, takeRewardCard } from './map.js';
import { buyCard, buyRelic, openShop, removeCard, restHeal, takeRestAction, upgradeCard } from './shop.js';
import {
  bledOut, choiceRequirementBuilt, chooseOption, eventChoices, flipMemoryCard, openEvent, purgeCard, runEffectBuilt, spendFightBuffs,
  wagerDraw, wagerStop,
} from './events.js';
import {
  clearSave, createRunState, dismissCompanion, loadBest, loadSave, recordBest, sacrificeOutsideFight, takeCompanion, writeSave,
} from './state.js';

const DATA_FILES = ['config', 'cards', 'enemies', 'companions', 'events', 'relics'];

const root = document.getElementById('app');
// Preferences the player sets once and keeps: the log open or shut, Call Your Shot on or off.
const freshUi = ({ logOpen = true, callShot = false } = {}) => ({
  selectedUid: null, // the card waiting for a target
  selectedSummonUid: null, // the summon waiting for a new target
  payment: null, // X for a "pay X health" card
  call: '', // the digits of a called shot, as typed
  message: null,
  confirm: null, // an action waiting for a second tap: 'breath', 'abandon', 'sacrifice:<id>', 'dismiss:<id>', 'bleed'
  sheet: null, // an open overlay: 'companions' or 'relics'
  logOpen,
  callShot,
});
const prefs = () => ({ logOpen: app.ui.logOpen, callShot: app.ui.callShot });
const app = {
  data: null,
  run: null,
  screen: 'title', // title | map | combat | reward | shop | rest | event | end
  combat: null,
  fightStart: null, // the fight as it began, frozen, for Second Breath
  view: {}, // what the current screen is showing: rewards on offer, shop stock, an open card picker
  ui: freshUi(),
  hasSave: false,
  best: null,
};

// ---------------------------------------------------------------------------
// Data loading. Ben edits these files by hand, so a typo gets a plain-English message, not a blank screen.

async function loadJson(name) {
  const path = `data/${name}.json`;
  let response;
  try {
    response = await fetch(path, { cache: 'no-store' }); // always the latest edit, never a cached copy
  } catch {
    throw new Error(location.protocol === 'file:'
      ? `Browsers refuse to load ${path} when index.html is opened as a file.\nServe the folder instead: python3 serve.py`
      : `Couldn't load ${path}.`);
  }
  if (!response.ok) throw new Error(`Couldn't load ${path} (${response.status} ${response.statusText}).`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} has a typo, so the game can't read it.\nLook for a missing comma, quote or bracket.\n\n${err.message}`);
  }
}

const indexById = (list) => Object.fromEntries(list.map((item) => [item.id, item]));

async function loadData() {
  // Config first, so even an error about another file shows in the game's own colors.
  const config = await loadJson('config');
  applyPalette(config.palette);
  const others = DATA_FILES.filter((name) => name !== 'config');
  const loaded = Object.fromEntries(await Promise.all(others.map(async (name) => [name, await loadJson(name)])));
  loaded.config = config;
  loaded.cardsById = indexById([...loaded.cards.cards, ...(loaded.cards.curses ?? [])]);
  loaded.enemiesById = indexById(loaded.enemies.enemies);
  loaded.summonTypesById = indexById(loaded.enemies.summonTypes ?? []);
  loaded.companionsById = indexById(loaded.companions.companions);
  loaded.curseIds = new Set((loaded.cards.curses ?? []).map((curse) => curse.id));
  loaded.eventsById = indexById(loaded.events.events);
  loaded.relicsById = indexById(loaded.relics.relics);
  return loaded;
}

// Every id one file uses must exist where it points. Typos get named, file by file.
function checkData(data) {
  const problems = [];
  const card = (id, where) => data.cardsById[id] || problems.push(`${where} lists card "${id}", but no card has that id.`);
  const enemy = (id, where) => data.enemiesById[id] || problems.push(`${where} lists enemy "${id}", but no enemy has that id.`);
  data.cards.startingDeck.forEach((id) => card(id, 'cards.json startingDeck'));
  for (const def of Object.values(data.cardsById)) {
    for (const effect of def.effects ?? []) {
      if (effect.type === 'summon' && !data.summonTypesById[effect.id]) {
        problems.push(`cards.json: "${def.id}" summons "${effect.id}", but enemies.json has no summonType with that id.`);
      }
    }
  }
  for (const encounter of data.enemies.encounters) encounter.enemies.forEach((id) => enemy(id, `enemies.json encounter "${encounter.id}"`));
  for (const def of data.enemies.enemies) {
    if (def.onDeath?.into) enemy(def.onDeath.into, `enemies.json "${def.id}" onDeath`);
    def.intents.filter((i) => i.type === 'summon').forEach((i) => enemy(i.id, `enemies.json "${def.id}" summon intent`));
    (def.passives ?? []).filter((p) => p.curseId).forEach((p) => card(p.curseId, `enemies.json "${def.id}" ${p.name}`));
  }
  // Events: every effect keyword must exist, and every card, relic rarity and lasting effect it names.
  for (const event of data.events.events) {
    const where = `events.json "${event.id}"`;
    const effects = [
      ...eventChoices(event).flatMap((choice) => choice.effects ?? []),
      ...(event.outcomes ?? []).flatMap((outcome) => outcome.effects ?? []),
      ...(event.rules?.prizes ?? []).flatMap((prize) => prize.effects),
    ];
    for (const choice of eventChoices(event)) {
      if (!choiceRequirementBuilt(choice)) problems.push(`${where} requires "${choice.requires}", which isn't in the game.`);
    }
    for (const effect of effects) {
      if (!runEffectBuilt(effect)) problems.push(`${where} uses "${effect.type}", which isn't in the game.`);
      if (['addCurse', 'addCard', 'removeCard'].includes(effect.type)) card(effect.id, where);
      if (effect.type === 'gainRelic' && effect.id && !data.relicsById[effect.id]) problems.push(`${where} gives relic "${effect.id}", but relics.json has no relic with that id.`);
      if (effect.type === 'gainCompanion' && !data.companionsById[effect.id]) problems.push(`${where} brings companion "${effect.id}", but companions.json has none with that id.`);
      if (effect.type === 'grantRunBuff' && !data.events.runBuffs?.[effect.id]) problems.push(`${where} grants "${effect.id}", but runBuffs has nothing by that name.`);
    }
  }
  for (const def of Object.values(data.cardsById).filter((c) => c.atRest)) {
    for (const effect of def.atRest.effects) {
      if (!runEffectBuilt(effect)) problems.push(`cards.json "${def.id}" atRest uses "${effect.type}", which isn't in the game.`);
      if (effect.type === 'gainRelic' && effect.id && !data.relicsById[effect.id]) problems.push(`cards.json "${def.id}" atRest gives relic "${effect.id}", but relics.json has no relic with that id.`);
    }
  }
  for (const relic of data.relics.relics) {
    for (const effect of relic.onPickup ?? []) {
      if (!runEffectBuilt(effect)) problems.push(`relics.json "${relic.id}" onPickup uses "${effect.type}", which isn't in the game.`);
    }
  }
  for (const { tier } of data.config.map.encounterTiers) {
    if (!data.enemies.encounters.some((e) => e.tier === tier)) problems.push(`config.json map.encounterTiers uses "${tier}", but no encounter has that tier.`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

// ---------------------------------------------------------------------------
// Saving. The run is saved after every redraw; it is cleared when the run ends.

function save() {
  if (app.screen === 'title' || !app.run) return;
  if (app.run.result) return clearSave();
  writeSave({
    run: app.run,
    screen: app.screen,
    view: app.view,
    combat: app.combat && freezeCombat(app.combat),
    fightStart: app.fightStart,
    prefs: prefs(),
  });
}

// A save made before a data edit may name cards or enemies that no longer exist. Such a save is dropped.
function usableSave(saved) {
  try {
    const instances = [...saved.run.deck, ...Object.values(saved.combat?.piles ?? {}).flat()];
    const known = instances.every((c) => app.data.cardsById[c.id]) &&
      (saved.combat?.enemies ?? []).every((e) => e.def || app.data.enemiesById[e.id]);
    return known && saved.run.map?.nodes ? saved : null;
  } catch {
    return null;
  }
}

function render() {
  renderScreen(root, app);
  save();
}

// ---------------------------------------------------------------------------
// The run

function newRun() {
  app.run = createRunState(app.data, generateMap(app.data));
  app.combat = null;
  app.fightStart = null;
  app.view = {};
  app.ui = freshUi(prefs());
  app.screen = 'map';
}

function continueRun() {
  const saved = usableSave(loadSave());
  if (!saved) {
    app.hasSave = false;
    return;
  }
  app.run = saved.run;
  app.screen = saved.screen;
  app.view = saved.view ?? {};
  app.combat = saved.combat ? upToDate(thawCombat(saved.combat, app.data)) : null;
  app.fightStart = saved.fightStart ?? null;
  app.ui = freshUi(saved.prefs ?? { logOpen: saved.logOpen });
  app.run.companions ??= [];
  app.run.relics ??= [];
  app.run.buffs ??= [];
  if (app.view.rewards?.companion && !app.view.offer) {
    app.view.offer = { companion: app.view.rewards.companion, taken: app.view.rewards.companionTaken };
  }
}

// A save from an earlier build may lack fields added since (companions, gold in the fight, called shots).
function upToDate(combat) {
  combat.companions ??= [...(app.run.companions ?? [])];
  combat.gold ??= app.run.gold;
  combat.shot ??= { bonuses: 0, energyNextTurn: 0 };
  combat.cleansed ??= false;
  combat.relics ??= [...(app.run.relics ?? [])];
  combat.cardsPlayed ??= 0;
  catchUpEnemies(combat);
  return combat;
}

function toMap() {
  app.view = {};
  app.screen = 'map';
}

function goToNode(id) {
  const node = enterNode(app.run, id);
  if (!node) return;
  app.view = {};
  if (FIGHT_TYPES.has(node.type)) startFight(node);
  else if (node.type === 'event') {
    app.view = { event: openEvent(node.event) };
    app.screen = 'event';
  } else if (node.type === 'shop') {
    app.view = { shop: openShop(app.data, app.run) };
    app.screen = 'shop';
  } else if (node.type === 'rest') app.screen = 'rest';
}

function startFight(node) {
  const encounter = app.data.enemies.encounters.find((e) => e.id === node.encounter);
  app.combat = createCombat(app.run, encounter, app.data);
  spendFightBuffs(app.run);
  app.fightStart = freezeCombat(app.combat);
  app.ui = freshUi(prefs());
  app.screen = 'combat';
}

// After the victory panel: the fight settles into the run, then rewards (or the end, after the boss).
function claimVictory() {
  const node = currentNode(app.run);
  settleFight(app.run, app.combat);
  app.combat = null;
  app.fightStart = null;
  if (node.type === 'boss') return endRun('won');
  const rewards = claimRewards(app.run, node, app.data);
  app.view = { rewards, offer: rewards.companion ? { companion: rewards.companion } : null };
  app.screen = 'reward';
}

// Second Breath: the current fight starts over exactly as it began. Three per run, then gone.
function secondBreath() {
  if (!app.run.secondBreaths || !app.fightStart) return;
  app.run.secondBreaths -= 1;
  app.run.stats.breathsUsed += 1;
  app.combat = upToDate(thawCombat(app.fightStart, app.data));
  app.ui = { ...freshUi(prefs()), message: `You breathe again. Second Breaths left: ${app.run.secondBreaths}.` };
}

function acceptDeath() {
  settleFight(app.run, app.combat);
  app.combat = null;
  endRun('lost');
}

function endRun(result) {
  app.run.result = result;
  recordBest(app.run);
  app.best = loadBest();
  app.hasSave = false;
  clearSave();
  app.view = {};
  app.screen = 'end';
}

// ---------------------------------------------------------------------------
// Combat input: tap a card, then tap a target. No drag, no hover.

const cardInHand = (uid) => {
  const instance = app.combat.piles.hand.find((c) => c.uid === uid);
  return instance && cardDef(app.combat, instance);
};

function clearSelection() {
  Object.assign(app.ui, { selectedUid: null, selectedSummonUid: null, payment: null, call: '' });
}

function tapCard(uid) {
  const { combat, ui } = app;
  const card = cardInHand(uid);
  if (!card) return;
  const check = playability(combat, card);
  if (!check.ok) {
    clearSelection();
    ui.message = `${card.name}: ${check.reason}`;
    return;
  }
  if (ui.selectedUid !== uid) {
    clearSelection();
    ui.selectedUid = uid;
    if (needsPayment(card)) ui.payment = paymentRange(combat).min;
    return;
  }
  // Second tap on the selected card: casts a card that needs no aim, cancels one that does.
  if (['self', 'all'].includes(targetMode(card))) tapTarget(combat.player.uid);
  else clearSelection();
}

// A tap on a creature. With a card selected, it's the card's target. Otherwise a tap on one of your
// summons picks it up, the next tap on an enemy becomes that summon's target, and a tap on an enemy
// with nothing selected explains its standing rules.
function tapTarget(targetUid) {
  const { combat, ui } = app;
  if (ui.selectedUid) {
    const card = cardInHand(ui.selectedUid);
    const call = ui.callShot && ui.call !== '' && canCallShot(card) ? Number(ui.call) : undefined;
    const logStart = combat.log.length;
    const result = playCard(combat, ui.selectedUid, targetUid, ui.payment, call);
    if (!result.ok) {
      ui.message = result.reason;
      return;
    }
    clearSelection();
    const verdict = combat.log.slice(logStart).find((entry) => entry.kind === 'call');
    if (verdict) ui.message = verdict.paid ? `Called it! +${verdict.reward} energy next turn.` : verdict.exact ? `Called it, but this turn's bonus is spent.` : `You called ${verdict.call}. It took ${verdict.actual}.`;
    return;
  }
  const summon = livingSummons(combat).find((s) => s.uid === targetUid && s.attack);
  if (summon) {
    ui.selectedSummonUid = ui.selectedSummonUid === summon.uid ? null : summon.uid;
    return;
  }
  if (ui.selectedSummonUid) {
    if (assignSummonTarget(combat, ui.selectedSummonUid, targetUid)) ui.selectedSummonUid = null;
    return;
  }
  const enemy = combat.enemies.find((e) => e.uid === targetUid);
  const def = enemy ? enemy.def ?? app.data.enemiesById[enemy.id] : {};
  const rules = [...(def.passives ?? []), ...(def.timedAbilities ?? [])];
  if (rules.length) ui.message = rules.map((p) => `${p.name}: ${p.text}`).join(' ');
}

// Step X for a "pay X health" card, kept inside what the player can afford.
function stepPayment(direction) {
  const { min, max } = paymentRange(app.combat);
  app.ui.payment = Math.min(max, Math.max(min, app.ui.payment + direction));
}

// Call Your Shot: digits typed on the keypad build the called number. No hit can take more HP than an
// enemy has, so a digit that would push the call past the healthiest one is ignored.
function typeCall(digit) {
  const next = Number(`${app.ui.call}${digit}`);
  const most = Math.max(...livingEnemies(app.combat).map((enemy) => enemy.hp));
  if (next <= most) app.ui.call = String(next);
}

// Companions: sacrificing or dismissing one takes two taps, because neither can be undone.
function confirmTwice(key, confirming, act) {
  if (confirming === key) act();
  else app.ui.confirm = key;
}

function sacrifice(id, confirming) {
  confirmTwice(`sacrifice:${id}`, confirming, () => {
    const companion = app.data.companionsById[id];
    const result = app.combat ? sacrificeInFight(app.combat, id) : sacrificeOutsideFight(app.run, app.data, id);
    if (!result.ok) {
      app.ui.message = result.reason;
      return;
    }
    app.ui.sheet = null;
    app.ui.message = `${companion.sacrifice.name}. ${companion.name} is gone.`;
  });
}

function dismiss(id, confirming) {
  confirmTwice(`dismiss:${id}`, confirming, () => {
    dismissCompanion(app.run, id);
    if (!app.run.companions.length) app.ui.sheet = null;
  });
}

// The companion marked on a reward or event screen joins as you leave. False if there's no room for them.
function takeOffer() {
  const { offer } = app.view;
  if (!offer?.chosen || offer.taken) return true;
  const result = takeCompanion(app.run, app.data, offer.companion);
  if (!result.ok) {
    app.ui.message = result.reason;
    return false;
  }
  offer.taken = true;
  return true;
}

// Events: paying HP outside a fight can kill you, so a step that would takes a second tap.
const wouldBleedOut = (effects) =>
  effects.some((effect) => ['payHealth', 'loseHealth'].includes(effect.type) && effect.amount >= app.run.player.hp);

// After any step of an event: a "remove a card" choice opens the picker; a companion with no room waits
// on the result screen; bleeding out ends the run where it stands.
function afterEventStep() {
  const state = app.view.event;
  if (bledOut(app.run)) {
    app.run.deathCause = app.data.eventsById[state.id].name;
    endRun('lost');
    return;
  }
  if (state.picking && !app.view.picker) app.view.picker = { purpose: 'purge' };
  const waiting = state.results.find((result) => result.companion && !result.joined);
  if (waiting && !app.view.offer) app.view.offer = { companion: waiting.companion };
}

// Spending a Second Breath mid-fight takes two taps, so it never happens by accident.
function tapBreath(confirming) {
  if (confirming === 'breath') {
    secondBreath();
  } else {
    clearSelection();
    app.ui.confirm = 'breath';
  }
}

// ---------------------------------------------------------------------------
// Every tap goes through here. `confirming` is the action that was waiting for a second tap, if any.

const ACTIONS = {
  // Title and end
  'new-run': (el, confirming) => {
    if (app.hasSave && confirming !== 'abandon') {
      app.ui.confirm = 'abandon';
      return;
    }
    newRun();
  },
  'continue-run': continueRun,

  // Map
  node: (el) => goToNode(el.dataset.id),
  deck: () => { app.view.picker = { purpose: 'deck' }; },

  // Combat
  card: (el) => tapCard(el.dataset.uid),
  target: (el) => tapTarget(el.dataset.uid),
  'pay-less': () => stepPayment(-1),
  'pay-more': () => stepPayment(+1),
  'end-turn': () => {
    clearSelection();
    endPlayerTurn(app.combat);
  },
  'toggle-log': () => { app.ui.logOpen = !app.ui.logOpen; },
  breath: (el, confirming) => tapBreath(confirming),
  'breath-restart': secondBreath,
  'accept-death': acceptDeath,
  claim: claimVictory,

  // Call Your Shot
  'call-toggle': () => {
    app.ui.callShot = !app.ui.callShot;
    app.ui.call = '';
  },
  'call-digit': (el) => typeCall(el.dataset.digit),
  'call-erase': () => { app.ui.call = app.ui.call.slice(0, -1); },

  // Companions
  companions: () => { app.ui.sheet = 'companions'; },
  'close-sheet': () => { app.ui.sheet = null; },
  stay: () => {}, // a tap inside an open sheet, between its buttons
  sacrifice: (el, confirming) => sacrifice(el.dataset.id, confirming),
  dismiss: (el, confirming) => dismiss(el.dataset.id, confirming),
  // A companion on offer (an elite's prisoner, an event) is marked here and joins when you leave the screen,
  // together with any card you picked.
  'offer-toggle': () => {
    const { offer } = app.view;
    offer.chosen = !offer.chosen;
  },

  // Events
  'event-choice': (el) => {
    const state = app.view.event;
    const index = Number(el.dataset.index);
    state.chosen = state.chosen === index ? null : index;
  },
  'event-go': (el, confirming) => {
    const state = app.view.event;
    const choice = eventChoices(app.data.eventsById[state.id])[state.chosen];
    if (!choice || (wouldBleedOut(choice.effects ?? []) && confirming !== 'bleed')) {
      if (choice) app.ui.confirm = 'bleed';
      return;
    }
    chooseOption(app.run, app.data, state, state.chosen);
    afterEventStep();
  },
  'mm-flip': (el) => {
    flipMemoryCard(app.run, app.data, app.view.event, Number(el.dataset.index));
    afterEventStep();
  },
  'wager-draw': (el, confirming) => {
    const state = app.view.event;
    const cost = app.data.eventsById[state.id].rules.costPerRound[state.game.round];
    if (cost >= app.run.player.hp && confirming !== 'bleed') {
      app.ui.confirm = 'bleed';
      return;
    }
    wagerDraw(app.run, app.data, state);
    afterEventStep();
  },
  'wager-stop': () => {
    wagerStop(app.run, app.data, app.view.event);
    afterEventStep();
  },
  'event-leave': () => {
    if (takeOffer()) toMap();
  },
  relics: () => { app.ui.sheet = 'relics'; },

  // Rewards
  'reward-card': (el) => {
    const index = Number(el.dataset.index);
    app.view.chosen = app.view.chosen === index ? undefined : index;
  },
  // One button takes everything picked on the reward screen: the card and the companion, either, both or neither.
  'reward-take': () => {
    if (!takeOffer()) return;
    const id = app.view.rewards.cards[app.view.chosen];
    if (id) takeRewardCard(app.run, id);
    toMap();
  },
  'reward-skip': toMap,

  // Shop
  'shop-item': (el) => {
    const index = Number(el.dataset.index);
    app.view.chosen = app.view.chosen === index ? undefined : index;
  },
  'shop-buy': () => {
    const result = buyCard(app.run, app.view.shop, app.view.chosen);
    app.ui.message = result.ok ? 'Added to your deck.' : result.reason;
    if (result.ok) app.view.chosen = undefined;
  },
  'shop-relic': (el) => {
    const { shop } = app.view;
    const item = shop.relics[Number(el.dataset.index)];
    const result = buyRelic(app.run, app.data, shop, Number(el.dataset.index));
    app.ui.message = result.ok ? `${app.data.relicsById[item.id].name} is yours.` : result.reason;
  },
  'shop-remove': () => { app.view.picker = { purpose: 'remove' }; },
  leave: toMap,

  // Rest
  'rest-heal': () => {
    restHeal(app.run, app.data);
    toMap();
  },
  'rest-upgrade': () => { app.view.picker = { purpose: 'upgrade' }; },
  // A card's own rest action (Nurture the Bound Wood Sapling): it takes the rest, like healing or upgrading.
  'rest-card': (el) => {
    const result = takeRestAction(app.run, app.data, el.dataset.id);
    if (!result.ok) {
      app.ui.message = result.reason;
      return;
    }
    toMap();
    app.ui.message = result.results.map((r) => r.text).filter(Boolean).join(' ');
  },

  // Card picker
  'pick-card': (el) => {
    const { picker } = app.view;
    picker.chosenUid = picker.chosenUid === el.dataset.uid ? null : el.dataset.uid;
  },
  'pick-cancel': () => { app.view.picker = null; },
  'pick-confirm': () => {
    const { picker } = app.view;
    if (picker.purpose === 'remove') {
      const result = removeCard(app.run, app.view.shop, picker.chosenUid);
      app.ui.message = result.ok ? 'Gone for good.' : result.reason;
      app.view.picker = null;
    } else if (picker.purpose === 'upgrade') {
      const result = upgradeCard(app.run, app.data, picker.chosenUid);
      if (result.ok) toMap();
      else app.ui.message = result.reason;
    } else if (picker.purpose === 'purge') {
      if (purgeCard(app.run, app.data, app.view.event, picker.chosenUid)) app.view.picker = null;
    }
  },
};

function onTap(event) {
  const el = event.target.closest('[data-action]');
  if (!el && event.target.closest('.log-body')) return; // reading the log shouldn't drop your card
  if (el?.disabled) return;
  const action = el?.dataset.action;
  const confirming = app.ui.confirm;
  app.ui.message = null;
  app.ui.confirm = null;
  try {
    if (ACTIONS[action]) ACTIONS[action](el, confirming);
    else if (app.ui.sheet) app.ui.sheet = null; // a tap outside an open sheet closes it
    else if (app.screen === 'combat') clearSelection();
  } catch (err) {
    console.error(err);
    app.ui.message = `Something broke: ${err.message}`;
  }
  render();
}

// ---------------------------------------------------------------------------

// Offline play (SPEC: PWA). Browsers only allow a service worker on https or localhost, so on the
// LAN dev server (plain http to another device) this quietly does nothing.
function playOffline() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline play is unavailable:', err));
}

async function boot() {
  playOffline();
  try {
    app.data = await loadData();
    checkData(app.data);
  } catch (err) {
    console.error(err);
    renderBootError(root, err.message);
    return;
  }
  app.hasSave = Boolean(usableSave(loadSave()));
  if (!app.hasSave) clearSave();
  app.best = loadBest();
  root.addEventListener('click', onTap);
  document.addEventListener('touchstart', () => {}, { passive: true }); // lets :active press states show on iOS
  render();
}

boot();
