// DOM rendering and animation.
// Draws the whole screen from state on every change. Hit, heal and block feedback comes from comparing
// each unit with how it looked on the previous render; the animations themselves live in styles/main.css.
//
// Rule from the spec: show base numbers and active modifiers separately, and never pre-compute the
// final damage of a card or an intent. The player does that math; the log shows it after the fact.

import { formatEntry } from './log.js';
import {
  canCallShot, canUpgrade, cardDef, cardModifiers, needsPayment, paymentRange, playability, resolveCard, targetMode, targetPrompt,
} from './cards.js';
import { builtPassives, enemyDef, intentPreview, timedPreview } from './combat.js';
import { livingSummons, summonIntentPreview } from './summons.js';
import { nextChoices } from './map.js';
import { restHealAmount } from './shop.js';
import { hasRoomForCompanion, sacrificeWorksOutsideFight } from './state.js';
import { eventChoices } from './events.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

// "1 hit", "3 hits".
const PLURAL = new Intl.PluralRules('en');
const count = (n, word) => `${n} ${word}${PLURAL.select(n) === 'one' ? '' : 's'}`;

// ---------------------------------------------------------------------------
// Theme: every color comes from config.json "palette", exposed to CSS as --pal-<name>.

export function applyPalette(palette) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(palette)) {
    if (!name.startsWith('_')) root.style.setProperty(`--pal-${name}`, value);
  }
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = palette.background;
}

export function renderBootError(root, message) {
  root.innerHTML = `<div class="boot"><div><h1>The torches won’t light.</h1><pre>${esc(message)}</pre></div></div>`;
}

// ---------------------------------------------------------------------------
// Screens

const SCREENS = {
  title: titleScreen,
  map: mapScreen,
  reward: rewardScreen,
  shop: shopScreen,
  rest: restScreen,
  event: eventScreen,
  end: endScreen,
};

export function renderScreen(root, app) {
  // Ambient loops (torch flicker, breathing) offset themselves by this clock, so rebuilding
  // the screen on every tap carries them on mid-cycle instead of restarting them.
  document.documentElement.style.setProperty('--clock', performance.now());
  if (app.screen === 'combat') renderCombat(root, app);
  else root.innerHTML = SCREENS[app.screen](app) + pickerOverlay(app) + companionSheet(app) + relicSheet(app);
}

// A card as it appears anywhere: hand, rewards, shop, deck. In a fight it can carry the modifiers acting on
// it right now (beside the base text, never folded into it) and the shot the player has called.
function cardFace(card, { action, uid, index, selected, dim, reason, mods = [], call } = {}) {
  const school = card.school ?? 'curse'; // curses in cards.json carry no school
  const sigil = document.getElementById(`sigil-${school}`) ? school : 'neutral';
  const hooks = [
    action && `data-action="${action}"`,
    uid && `data-uid="${esc(uid)}"`,
    index !== undefined && `data-index="${index}"`,
  ].filter(Boolean).join(' ');
  return `
    <button class="card ${selected ? 'selected' : ''} ${dim ? 'unplayable' : ''}" ${hooks}
            data-school="${esc(school)}" data-rarity="${esc(card.rarity ?? 'curse')}"
            style="--school: var(--school-${esc(school)}, var(--school-neutral))">
      <span class="cost" aria-label="Cost">${esc(card.cost ?? '–')}</span>
      <span class="card-name">${esc(card.name)}</span>
      <span class="card-text">${esc(card.text)}</span>
      ${mods.length ? `<span class="card-mods">${mods.map((mod) => `<span class="card-mod">${esc(mod)}</span>`).join('')}</span>` : ''}
      ${call !== undefined ? `<span class="call-tag">Call ${esc(call || '?')}</span>` : ''}
      ${reason ? `<span class="card-reason">${esc(reason)}</span>` : ''}
      <svg class="sigil" role="img" aria-label="${esc(school)}"><use href="#sigil-${esc(sigil)}"/></svg>
    </button>`;
}

const message = (app) => (app.ui.message ? `<p class="board-message" role="status">${esc(app.ui.message)}</p>` : '');

// ---------------------------------------------------------------------------
// HUD. The same stones everywhere: HP, gold, Second Breaths; energy and block join in a fight.

const hpStat = (unit) =>
  `<span class="stat hp" aria-label="Health">${icon('heart')}<b>${unit.hp}</b><span class="of">/ ${unit.maxHp}</span><span class="cap">HP</span></span>`;
const goldStat = (run) => `<span class="stat gold" aria-label="Gold">${icon('coin')}<b>${run.gold}</b><span class="cap">Gold</span></span>`;

function breathStat(run, { button } = {}) {
  const inner = `${icon('breath')}<b>${run.secondBreaths}</b><span class="cap">Breaths</span>`;
  return button
    ? `<button class="stat breaths" data-action="breath" aria-label="Second Breaths: restart this fight" ${run.secondBreaths ? '' : 'disabled'}>${inner}</button>`
    : `<span class="stat breaths" aria-label="Second Breaths">${inner}</span>`;
}

// Companions ride in the HUD as small seals in their school's color; a tap opens their sheet.
function medallion(data, id) {
  const companion = data.companionsById[id];
  return `<span class="medallion" style="--school: var(--school-${esc(companion.school)}, var(--school-neutral))" title="${esc(companion.name)}"><svg aria-hidden="true"><use href="#sigil-${esc(companion.school)}"/></svg></span>`;
}

function alliesStat(data, ids) {
  if (!ids.length) return '';
  return `<button class="stat allies" data-action="companions" aria-label="Your companions">${ids.map((id) => medallion(data, id)).join('')}<span class="cap">Allies</span></button>`;
}

// Relics and lasting event effects share one stone: a tap opens the list.
function relicsStat(run) {
  if (!run.relics.length && !run.buffs.length && !run.skipNextReward) return '';
  return `<button class="stat relics" data-action="relics" aria-label="Your relics">${icon('relic')}<b>${run.relics.length}</b><span class="cap">Relics</span></button>`;
}

function runHud(app) {
  const { run, data } = app;
  return `
    <header class="hud">
      <h1 class="title">Dungeon Run</h1>
      <span class="turn">Depth <b>${run.visited.length}</b><span class="of">/ ${data.config.run.nodeCount}</span></span>
      ${hpStat(run.player)}
      ${goldStat(run)}
      ${breathStat(run)}
      ${alliesStat(data, run.companions)}
      ${relicsStat(run)}
      <button class="stat deck-button" data-action="deck" aria-label="Your deck">${icon('deck')}<b>${run.deck.length}</b><span class="cap">Deck</span></button>
    </header>`;
}

function torch(side) {
  return `
    <span class="torch ${side}" aria-hidden="true">
      <svg class="sconce"><use href="#deco-sconce"/></svg>
      <svg class="flame"><use href="#deco-flame"/></svg>
    </span>`;
}

// ---------------------------------------------------------------------------
// Title

function titleScreen(app) {
  const { best, hasSave, ui } = app;
  const abandoning = ui.confirm === 'abandon';
  return `
    <div class="screen title-screen">
      ${torch('left')}
      ${torch('right')}
      <section class="slab title-slab">
        <h1 class="game-title">Dungeon Run</h1>
        <p class="tagline">A sorcerer, a forbidden book, and the king’s dungeon.</p>
        <div class="actions column">
          ${hasSave ? '<button class="big-button" data-action="continue-run">Continue</button>' : ''}
          <button class="${hasSave ? 'plain-button' : 'big-button'}" data-action="new-run">
            ${hasSave ? (abandoning ? 'Tap again to abandon that run' : 'Start a new run') : 'Descend'}
          </button>
        </div>
        ${best ? `<p class="best">Deepest so far: depth ${esc(best.depth)}${best.won ? ', and the boss fell' : ''}.</p>` : ''}
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// Map: a page torn from the book, the paths inked on it. Portrait reads top to bottom, landscape left to right.

const NODE_LABELS = { combat: 'Fight', elite: 'Elite', shop: 'Shop', rest: 'Rest', event: 'Event', boss: 'Boss' };

function mapScreen(app) {
  const { run } = app;
  const { rows, nodes } = run.map;
  const open = new Set(nextChoices(run).map((node) => node.id));
  const walked = new Set(run.visited);
  const here = run.position && nodes[run.position];
  // Where a node sits on the page, as fractions: across its depth's row, and down the depths.
  const place = (node) => ({ across: (node.index + 0.5) / node.count, along: (node.depth - 0.5) / rows.length });
  const stateOf = (node) => {
    if (node.id === run.position) return 'here';
    if (walked.has(node.id)) return 'walked';
    if (open.has(node.id)) return 'open';
    if (here && node.depth <= here.depth) return 'past';
    return 'ahead';
  };
  const lines = Object.values(nodes).flatMap((node) => node.next.map((id) => {
    const to = nodes[id];
    const kind = walked.has(node.id) && walked.has(to.id) ? 'walked' : node.id === run.position && open.has(to.id) ? 'open' : '';
    const [a, b] = [place(node), place(to)];
    return `<line class="${kind}" x1="${a.across}" y1="${a.along}" x2="${b.across}" y2="${b.along}" vector-effect="non-scaling-stroke"/>`;
  }));
  return `
    <div class="screen map-screen">
      ${runHud(app)}
      <section class="map" aria-label="The dungeon map"><div class="map-inner">
        <svg class="map-paths" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><g>${lines.join('')}</g></svg>
        ${Object.values(nodes).map((node) => {
          const { across, along } = place(node);
          const state = stateOf(node);
          const label = NODE_LABELS[node.type] ?? node.type;
          return `
            <button class="node type-${esc(node.type)} ${state}" data-action="node" data-id="${esc(node.id)}"
                    style="--across: ${across}; --along: ${along}" ${state === 'open' ? '' : 'disabled'}
                    aria-label="${esc(label)}, depth ${node.depth}">
              <span class="stamp"><svg class="node-icon" aria-hidden="true"><use href="#node-${esc(node.type)}"/></svg></span>
              <span class="node-label">${esc(label)}</span>
            </button>`;
        }).join('')}
      </div></section>
      <p class="map-caption">${run.position ? 'Choose where to go next.' : 'The stairs split. Choose your way down.'}</p>
      ${message(app)}
    </div>`;
}

// ---------------------------------------------------------------------------
// Reward, shop, rest

// Everything an elite or a fight gives, on one screen: gold and any relic are already yours; pick a card,
// mark the companion if there is one, and one button takes what you picked.
function rewardScreen(app) {
  const { rewards, chosen, offer } = app.view;
  const choice = chosen !== undefined ? app.data.cardsById[rewards.cards[chosen]] : null;
  const companion = offer?.chosen && !offer.taken ? app.data.companionsById[offer.companion] : null;
  const picks = [choice?.name, companion?.name].filter(Boolean);
  const takeLabel = picks.length ? `Take ${picks.join(' and ')}` : rewards.cards.length ? 'Continue without a card' : 'Continue';
  return `
    <div class="screen">
      ${runHud(app)}
      <section class="board">
        <h2 class="board-title">Victory</h2>
        ${rewards.skippedFor
    ? `<p class="board-prompt">No reward this time. ${esc(rewards.skippedFor)} cost you this one.</p>`
    : `<p class="gain">${icon('coin')}<b>+${rewards.gold}</b> gold</p>
        ${rewards.relic ? `<p class="found">Relic found. It's yours.</p><div class="relic-list">${relicPlaque(app.data, rewards.relic)}</div>` : ''}
        <p class="board-prompt">${rewards.cards.length ? 'Tap a card to add it to your deck, or take none.' : 'No cards this time.'}</p>`}
        <div class="card-row">
          ${rewards.cards.map((id, index) => cardFace(app.data.cardsById[id], { action: 'reward-card', index, selected: chosen === index })).join('')}
        </div>
        ${offer ? companionOffer(app, offer, 'In the cell, someone is still breathing.') : ''}
        <div class="actions"><button class="big-button" data-action="reward-take">${esc(takeLabel)}</button></div>
        ${message(app)}
      </section>
    </div>`;
}

function shopScreen(app) {
  const { run, data } = app;
  const { shop, chosen } = app.view;
  const item = chosen !== undefined ? shop.stock[chosen] : null;
  const card = item && data.cardsById[item.id];
  const canBuy = item && !item.sold && run.gold >= item.price;
  const buyLabel = !item ? 'Pick a card' : item.sold ? 'Sold' : run.gold < item.price ? 'Not enough gold' : `Buy ${esc(card.name)}`;
  const canRemove = !shop.removalUsed && run.gold >= shop.removalPrice;
  return `
    <div class="screen">
      ${runHud(app)}
      <section class="board">
        <h2 class="board-title">The Shop</h2>
        <p class="board-prompt">A hooded trader with a cart of torn pages. Tap a card to look, then buy.</p>
        <div class="card-row">
          ${shop.stock.map((stock, index) => `
            <div class="for-sale ${stock.sold ? 'sold' : ''}">
              ${cardFace(data.cardsById[stock.id], { action: 'shop-item', index, selected: chosen === index, dim: stock.sold || run.gold < stock.price })}
              <span class="price ${run.gold < stock.price ? 'short' : ''}">${stock.sold ? 'Sold' : `${icon('coin')}<b>${stock.price}</b>`}</span>
            </div>`).join('')}
        </div>
        <div class="actions">
          <button class="big-button" data-action="shop-buy" ${canBuy ? '' : 'disabled'}>${buyLabel}</button>
          <button class="plain-button" data-action="shop-remove" ${canRemove ? '' : 'disabled'}>
            ${shop.removalUsed ? 'Card removed' : `Remove a card ${icon('coin')}<b>${shop.removalPrice}</b>`}
          </button>
          <button class="plain-button" data-action="leave">Leave</button>
        </div>
        ${message(app)}
      </section>
    </div>`;
}

function restScreen(app) {
  const { run, data } = app;
  const upgradable = run.deck.some((card) => canUpgrade(data, card));
  const healed = Math.min(restHealAmount(run, data), run.player.maxHp - run.player.hp);
  return `
    <div class="screen">
      ${runHud(app)}
      <section class="board">
        <h2 class="board-title">A Place to Rest</h2>
        <p class="board-prompt">A dry corner and a little fire. Rest, or work on one spell. Not both.</p>
        <div class="choices">
          <button class="choice" data-action="rest-heal">
            <svg class="choice-icon" aria-hidden="true"><use href="#node-rest"/></svg>
            <b>Rest</b><span>${healed ? `Heal ${healed} HP` : 'Already at full health'}</span>
          </button>
          <button class="choice" data-action="rest-upgrade" ${upgradable ? '' : 'disabled'}>
            <svg class="choice-icon" aria-hidden="true"><use href="#sigil-neutral"/></svg>
            <b>Upgrade</b><span>${upgradable ? 'Improve one card' : 'No card can be upgraded'}</span>
          </button>
        </div>
        <div class="actions"><button class="plain-button" data-action="leave">Leave</button></div>
        ${message(app)}
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// Companions: a plaque each, with what they do while with you and what their sacrifice would do.

function companionPlaque(data, id, actions = '') {
  const companion = data.companionsById[id];
  return `
    <article class="companion" style="--school: var(--school-${esc(companion.school)}, var(--school-neutral))">
      <header class="companion-head">${medallion(data, id)}<h3>${esc(companion.name)}</h3></header>
      <p class="flavor">${esc(companion.flavor)}</p>
      <p class="passive"><b>While with you:</b> ${esc(companion.passive.text)}</p>
      <p class="sacrifice-text"><b>Sacrifice: ${esc(companion.sacrifice.name)}.</b> ${esc(companion.sacrifice.text)}</p>
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </article>`;
}

// After an elite: someone in its cell is still breathing.
// A companion on offer: tap to bring them (they join when you leave the screen), tap again to leave them.
function companionOffer(app, offer, title) {
  const { data, run } = app;
  const room = hasRoomForCompanion(run, data);
  const actions = offer.taken
    ? '<span class="small">With you now.</span>'
    : `<button class="plain-button offer-toggle ${offer.chosen ? 'on' : ''}" data-action="offer-toggle" aria-pressed="${Boolean(offer.chosen)}" ${room || offer.chosen ? '' : 'disabled'}>
         ${offer.chosen ? 'Coming with you. Tap to leave them.' : 'Bring them with you'}</button>
       ${room ? '' : `<span class="small">You can keep ${data.companions.maxCompanions}. Tap Allies above to dismiss or sacrifice one first.</span>`}`;
  return `
    <section class="offer ${offer.chosen ? 'chosen' : ''}">
      <h3 class="offer-title">${esc(title)}</h3>
      ${companionPlaque(data, offer.companion, actions)}
    </section>`;
}

// The sheet behind the Allies seals. Sacrifice is always here, always permanent; both it and dismissing
// take a second tap. In a fight a companion can only be sacrificed, on your turn.
function companionSheet(app) {
  if (app.ui.sheet !== 'companions') return '';
  const { data, combat, run, ui } = app;
  const ids = combat ? combat.companions : run.companions;
  const plaques = ids.map((id) => {
    const asked = (what) => ui.confirm === `${what}:${id}`;
    const usable = combat ? combat.phase === 'player' : sacrificeWorksOutsideFight(data, id);
    const sacrificeButton = `<button class="big-button sacrifice-button" data-action="sacrifice" data-id="${esc(id)}" ${usable ? '' : 'disabled'}>
        ${asked('sacrifice') ? 'Tap again: gone for good' : `Sacrifice: ${esc(data.companionsById[id].sacrifice.name)}`}</button>`;
    const dismissButton = combat ? '' : `<button class="plain-button" data-action="dismiss" data-id="${esc(id)}">${asked('dismiss') ? 'Tap again to dismiss' : 'Dismiss'}</button>`;
    const note = usable ? '' : `<span class="small">${combat ? 'Only on your turn.' : 'Only works in a fight.'}</span>`;
    return companionPlaque(data, id, sacrificeButton + dismissButton + note);
  });
  return `
    <div class="overlay" data-action="close-sheet">
      <section class="sheet" role="dialog" aria-label="Your companions" data-action="stay">
        <header class="sheet-head">
          <h2 class="board-title">Your companions</h2>
          <button class="plain-button" data-action="close-sheet">Close</button>
        </header>
        <div class="companion-list">${plaques.join('') || '<p class="board-prompt">No one walks with you.</p>'}</div>
        ${message(app)}
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// Relics: kept for the run. A plaque each, its edge showing its rarity like a card's frame.

function relicPlaque(data, id) {
  const relic = data.relicsById[id];
  return `
    <article class="relic" data-rarity="${esc(relic.rarity)}">
      <header class="relic-head">${icon('relic')}<h3>${esc(relic.name)}</h3></header>
      <p>${esc(relic.text)}</p>
    </article>`;
}

// The sheet behind the Relics stone: relics, then what an event left hanging over the next few fights.
function relicSheet(app) {
  if (app.ui.sheet !== 'relics') return '';
  const { data, run } = app;
  const lasting = [
    ...run.buffs.map((buff) => `<li><b>${esc(buff.name)}</b> ${esc(buff.text)} <span class="small">(${esc(count(buff.fightsLeft, 'fight'))} left)</span></li>`),
    ...(run.skipNextReward ? [`<li><b>${esc(run.skipNextReward)}</b> No reward after your next fight.</li>`] : []),
  ];
  return `
    <div class="overlay" data-action="close-sheet">
      <section class="sheet" role="dialog" aria-label="Your relics" data-action="stay">
        <header class="sheet-head">
          <h2 class="board-title">Relics</h2>
          <button class="plain-button" data-action="close-sheet">Close</button>
        </header>
        <div class="relic-list">${run.relics.map((id) => relicPlaque(data, id)).join('') || '<p class="board-prompt">You carry nothing yet.</p>'}</div>
        ${lasting.length ? `<h3 class="offer-title">Hanging over you</h3><ul class="lasting">${lasting.join('')}</ul>` : ''}
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// Events: a room, a choice, a cost. Choose (tap a choice, then commit), play a minigame, see what happened.

function eventScreen(app) {
  const state = app.view.event;
  const def = app.data.eventsById[state.id];
  const body = { choose: eventChoose, play: def.minigame === 'memory_match' ? memoryBoard : wagerBoard, done: eventDone }[state.phase](app, def, state);
  return `
    <div class="screen">
      ${runHud(app)}
      <section class="board event">
        <h2 class="board-title">${esc(def.name)}</h2>
        ${body}
        ${message(app)}
      </section>
    </div>`;
}

function eventChoose(app, def, state) {
  const choices = eventChoices(def);
  const chosen = choices[state.chosen];
  const bleeding = app.ui.confirm === 'bleed';
  return `
    <p class="flavor-text">${esc(def.flavor)}</p>
    ${def.rules ? `<p class="board-prompt">${esc(def.rules.description)}</p>` : ''}
    <div class="event-choices">
      ${choices.map((choice, index) => `
        <button class="choice event-choice ${state.chosen === index ? 'selected' : ''} ${choice.walkAway ? 'walk-away' : ''}" data-action="event-choice" data-index="${index}">
          <b>${esc(choice.label)}</b><span>${esc(choice.text)}</span>
        </button>`).join('')}
    </div>
    <div class="actions">
      <button class="big-button ${bleeding ? 'deadly' : ''}" data-action="event-go" ${chosen ? '' : 'disabled'}>
        ${bleeding ? 'Tap again: this will kill you' : chosen ? esc(chosen.label) : 'Choose one'}
      </button>
    </div>`;
}

// What happened: each effect's line, then anything worth seeing up close.
function eventDone(app, def, state) {
  const { data } = app;
  const cards = state.results.filter((r) => r.card).map((r) => cardFace(data.cardsById[r.card]));
  const relics = state.results.filter((r) => r.relic).map((r) => relicPlaque(data, r.relic));
  const lines = state.results.filter((r) => r.text);
  return `
    ${state.game?.kind === 'memory_match' ? memoryGrid(state.game, { reveal: true }) : ''}
    <ul class="results">${lines.map((r) => `<li class="${r.headline ? 'headline' : ''}">${esc(r.text)}</li>`).join('')}</ul>
    ${cards.length ? `<div class="card-row">${cards.join('')}</div>` : ''}
    ${relics.length ? `<div class="relic-list">${relics.join('')}</div>` : ''}
    ${app.view.offer ? companionOffer(app, app.view.offer, 'Someone wants to come with you.') : ''}
    <div class="actions"><button class="big-button" data-action="event-leave" ${state.picking ? 'disabled' : ''}>Continue</button></div>`;
}

// The Dealer's Table. Faces are drawn from the game's own sigils and icons, each in its own color.
const MEMORY_FACES = ['sigil-necromancy', 'sigil-darkhold', 'sigil-elemental', 'icon-heart', 'icon-coin', 'node-boss', 'icon-sword', 'icon-breath', 'node-rest', 'icon-shield'];

function memoryGrid(game, { reveal } = {}) {
  return `
    <div class="memory-grid" style="--cards: ${game.cards.length}">
      ${game.cards.map((face, index) => {
        const shown = reveal || game.matched[index] || game.up.includes(index);
        const state = game.matched[index] ? 'matched' : game.up.includes(index) ? 'up' : 'down';
        return `
          <button class="memory-card ${shown ? 'shown' : ''} ${state} ${game.last === index && !reveal ? 'just' : ''}" data-action="mm-flip" data-index="${index}" data-face="${face}"
                  aria-label="${shown ? `Card ${face}` : 'Face down'}" ${game.over || game.matched[index] ? 'disabled' : ''}>
            ${shown ? `<svg aria-hidden="true"><use href="#${MEMORY_FACES[face % MEMORY_FACES.length]}"/></svg>` : ''}
          </button>`;
      }).join('')}
    </div>`;
}

function memoryBoard(app, def, state) {
  const { game } = state;
  return `
    <p class="board-prompt">Turn over two cards. A match stays up. Every two cards is one flip.</p>
    <p class="tally"><span>Flips left <b>${game.flipsLeft}</b></span><span>Pairs <b>${game.pairsFound}</b> / ${game.pairs}</span></p>
    ${memoryGrid(game)}`;
}

// The Blood Wager. The whole ladder is on the board: every round's cost, its odds of the Rot, and its prize.
const PERCENT = new Intl.NumberFormat('en', { style: 'percent' });

function wagerBoard(app, def, state) {
  const { game } = state;
  const { costPerRound, rotChancePerRound, prizes } = def.rules;
  const prize = game.prize === null ? null : prizes[game.prize];
  const bleeding = app.ui.confirm === 'bleed';
  const cost = costPerRound[game.round];
  const last = game.draws.at(-1);
  return `
    <p class="flavor-text">${esc(def.rules.description)}</p>
    <ol class="ladder">
      ${prizes.map((tier, round) => `
        <li class="${round < game.round ? 'cleared' : round === game.round ? 'next' : ''}">
          <span class="rung-cost">${icon('heart')}<b>${esc(costPerRound[round])}</b> HP</span>
          <span class="rung-rot">Rot <b>${esc(PERCENT.format(rotChancePerRound[round]))}</b></span>
          <span class="rung-prize">${esc(tier.label)}</span>
        </li>`).join('')}
    </ol>
    ${last ? `<p class="draw ${last}">${last === 'clean' ? 'Clean.' : 'The Rot.'}</p>` : ''}
    <p class="tally"><span>At stake: <b>${prize ? esc(prize.label) : 'nothing yet'}</b></span><span>Your HP <b>${app.run.player.hp}</b></span></p>
    <div class="actions">
      <button class="big-button ${bleeding ? 'deadly' : ''}" data-action="wager-draw">
        ${bleeding ? 'Tap again: this will kill you' : `Cut again: pay ${esc(cost)} HP`}
      </button>
      <button class="plain-button" data-action="wager-stop">${prize ? `Stop and take ${esc(prize.label)}` : 'Walk away'}</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Card picker: view the deck, or choose a card to remove or upgrade.

const PICKERS = {
  deck: { title: 'Your deck', confirm: null, filter: () => true },
  remove: { title: 'Remove a card', confirm: 'Remove it', filter: () => true },
  upgrade: { title: 'Upgrade a card', confirm: 'Upgrade it', filter: (data, card) => canUpgrade(data, card) },
  purge: { title: 'Burn a card', confirm: 'Burn it', filter: () => true, required: true }, // an event's choice: no backing out
};

function pickerOverlay(app) {
  const picker = app.view.picker;
  if (!picker) return '';
  const { data, run } = app;
  const kind = PICKERS[picker.purpose];
  const cards = run.deck.filter((card) => kind.filter(data, card));
  const chosen = cards.find((card) => card.uid === picker.chosenUid);
  const preview = chosen && picker.purpose === 'upgrade' ? resolveCard(data, { ...chosen, upgraded: true }) : null;
  const before = chosen && resolveCard(data, chosen);
  const costChange = preview && preview.cost !== before.cost ? ` Costs ${esc(preview.cost)} instead of ${esc(before.cost)}.` : '';
  const footnote = preview
    ? `Becomes <b>${esc(preview.name)}</b>: ${esc(preview.text)}${costChange}`
    : chosen ? `${esc(resolveCard(data, chosen).name)} leaves your deck for good.` : 'Tap a card.';
  return `
    <div class="overlay">
      <section class="sheet" role="dialog" aria-label="${esc(kind.title)}">
        <header class="sheet-head">
          <h2 class="board-title">${esc(kind.title)}</h2>
          ${kind.required ? '' : `<button class="plain-button" data-action="pick-cancel">${kind.confirm ? 'Cancel' : 'Close'}</button>`}
        </header>
        <div class="card-grid">
          ${cards.map((card) => cardFace(resolveCard(data, card), { action: kind.confirm ? 'pick-card' : null, uid: card.uid, selected: card.uid === picker.chosenUid })).join('')}
        </div>
        ${kind.confirm ? `
          <footer class="sheet-foot">
            <span class="preview">${footnote}</span>
            <button class="big-button" data-action="pick-confirm" ${chosen ? '' : 'disabled'}>${esc(kind.confirm)}</button>
          </footer>` : ''}
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// End of the run

function endScreen(app) {
  const { run, data } = app;
  const won = run.result === 'won';
  const { stats } = run;
  const bossEncounter = data.enemies.encounters.find((e) => e.tier === 'boss');
  const [bossId] = bossEncounter?.enemies ?? [];
  const bossName = data.enemiesById[bossId]?.name ?? 'The boss';
  const rows = [
    ['Depth reached', `${run.visited.length} / ${data.config.run.nodeCount}`],
    ['Fights won', stats.fightsWon],
    ['Enemies slain', stats.enemiesDefeated],
    ['Gold earned', stats.goldEarned],
    ['Cards added', stats.cardsAdded],
    ['Turns fought', stats.turns],
    ['Second Breaths used', stats.breathsUsed],
    ['Cards in deck', run.deck.length],
  ];
  return `
    <div class="screen end-screen">
      <section class="slab ${won ? 'won' : 'lost'}">
        <h1 class="game-title">${won ? 'Victory' : 'You Have Fallen'}</h1>
        <p class="tagline">${won ? `${esc(bossName)} is dead. The kingdom breathes.`
    : run.deathCause ? `Bled out at ${esc(run.deathCause)}, depth ${run.visited.length} of ${data.config.run.nodeCount}.`
      : `Depth ${run.visited.length} of ${data.config.run.nodeCount}. The dungeon keeps you.`}</p>
        <dl class="summary">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
        <div class="actions column"><button class="big-button" data-action="new-run">New run</button></div>
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// Combat screen

const memory = { combat: null, units: new Map(), logLength: 0 };

function renderCombat(root, app) {
  const { combat, ui } = app;
  const fresh = memory.combat !== combat;
  // Hits resolved since the last redraw: each one gets a damage number over the unit it struck.
  const news = fresh ? [] : combat.log.slice(memory.logLength);
  const hits = news.filter((entry) => entry.kind === 'hit');
  const fx = unitEffects(combat, fresh);
  // An enemy whose timed ability fired since the last redraw flares (the crab's shard).
  for (const entry of news.filter((e) => e.kind === 'timed')) {
    const unit = fx.get(entry.byUid);
    if (unit) unit.classes += ' fx-beam';
  }
  const oldLog = root.querySelector('.log-body');
  const oldScroll = oldLog?.scrollTop;

  root.innerHTML = `
    <div class="combat ${ui.logOpen ? '' : 'log-collapsed'}">
      ${combatHud(app)}
      ${field(app, fx, hits)}
      ${logPanel(combat, ui)}
      ${controls(app)}
      ${hand(combat, ui)}
    </div>
    ${companionSheet(app)}
    ${relicSheet(app)}`;

  const logBody = root.querySelector('.log-body');
  if (logBody) {
    const grew = combat.log.length !== memory.logLength;
    logBody.scrollTop = grew || oldScroll === undefined ? logBody.scrollHeight : oldScroll;
  }
  memory.logLength = combat.log.length;
}

// Compare each unit with the previous render to decide which feedback animation to play,
// and remember its old HP so the health bar can drain from there instead of jumping.
function unitEffects(combat, fresh) {
  if (fresh) memory.units.clear();
  const fx = new Map();
  for (const unit of [combat.player, ...combat.summons, ...combat.enemies]) {
    const prev = memory.units.get(unit.uid);
    const classes = [];
    if (prev && unit.taken && !prev.taken) {
      classes.push('fx-taken'); // carried off by the beam: not a hit, not a death
    } else if (prev) {
      if (unit.hp < prev.hp) classes.push('fx-hit');
      if (unit.hp > prev.hp) classes.push('fx-heal');
      if (unit.block > prev.block) classes.push('fx-block');
      if (unit.hp === prev.hp && unit.block < prev.block) classes.push('fx-guard');
      if (unit.hp <= 0 && prev.hp > 0) classes.push('fx-die');
      if (unit.armor && prev.armorLeft && !unit.armor.hitsLeft) classes.push('fx-armor-break');
    }
    fx.set(unit.uid, { classes: classes.join(' '), prevHp: prev?.hp ?? unit.hp, prevArmor: prev?.armorLeft ?? unit.armor?.hitsLeft });
    memory.units.set(unit.uid, { hp: unit.hp, block: unit.block, taken: unit.taken, armorLeft: unit.armor?.hitsLeft });
  }
  memory.combat = combat;
  return fx;
}

function selectedCard(combat, ui) {
  const instance = combat.piles.hand.find((c) => c.uid === ui.selectedUid);
  return instance ? cardDef(combat, instance) : null;
}

function combatHud(app) {
  const { combat, run } = app;
  const { player } = combat;
  const { energyPerTurn } = combat.data.config.player;
  return `
    <header class="hud">
      <h1 class="title">Dungeon Run</h1>
      <span class="turn">Turn <b>${combat.turn}</b></span>
      ${hpStat(player)}
      <span class="stat block" aria-label="Block">${icon('shield')}<b>${player.block}</b><span class="cap">Block</span></span>
      <span class="stat energy ${player.energy ? '' : 'spent'}" aria-label="Energy">
        <span class="orb"><b>${player.energy}</b></span><span class="of">/ ${energyPerTurn}</span><span class="cap">Energy</span>
      </span>
      ${goldStat(combat)}
      ${breathStat(run, { button: combat.phase === 'player' })}
      ${alliesStat(combat.data, combat.companions)}
      ${relicsStat(run)}
    </header>`;
}

function field(app, fx, hits) {
  const { combat, ui } = app;
  const card = selectedCard(combat, ui);
  const mode = card && targetMode(card);
  const planning = combat.phase === 'player';
  // Enemies are targets for a card that hits an enemy (or all of them), or for a summon waiting for orders.
  const enemiesTargetable = mode === 'enemy' || mode === 'all' || Boolean(ui.selectedSummonUid);
  // Creatures that died (or were taken) on this render stay one frame longer so their animation can play.
  const shown = (units) => units.filter((unit) => unit.hp > 0 || /fx-die|fx-taken/.test(fx.get(unit.uid).classes));
  const isBoss = (enemy) => enemyDef(combat, enemy).tier === 'boss';
  const bossRoom = combat.enemies.some(isBoss);
  const summons = shown(combat.summons);
  const enemies = shown(combat.enemies);
  // --units tells the board how many creatures share it, so crowded fights draw them smaller.
  // A boss takes a wider share (--bosses), so it still dwarfs its minions on a crowded board.
  const units = summons.length + enemies.length + 1;
  return `
    <section class="field" data-room="${bossRoom ? 'boss' : 'cell'}" data-units="${units}" style="--units: ${units}; --bosses: ${enemies.filter(isBoss).length}">
      ${torch('left')}
      ${torch('right')}
      <div class="side allies">
        ${unitView(combat, combat.player, { targetable: mode === 'self' || mode === 'all', fx: fx.get('player'), hits })}
        ${summons.map((summon) => unitView(combat, summon, {
          targetable: mode === 'summon' && summon.hp > 0,
          selected: ui.selectedSummonUid === summon.uid,
          fx: fx.get(summon.uid),
          hits,
          intent: summon.hp > 0 && planning ? summonIntentPreview(combat, summon) : null,
        })).join('')}
      </div>
      <div class="side foes">
        ${enemies.map((enemy) => unitView(combat, enemy, {
          targetable: enemiesTargetable && enemy.hp > 0,
          fx: fx.get(enemy.uid),
          hits,
          intent: enemy.hp > 0 && planning ? intentPreview(combat, enemy) : null,
          timed: enemy.hp > 0 ? timedPreview(combat, enemy) : [],
          planning,
        })).join('')}
      </div>
      ${outcomePanel(app)}
    </section>`;
}

function unitView(combat, unit, { targetable, selected, fx, intent, hits, timed = [], planning }) {
  const sprite = document.getElementById(`sprite-${unit.id}`) ? unit.id : 'unknown';
  // Armor gets its own counter chip (below), so its name isn't repeated as a plain trait.
  const passives = unit.kind === 'enemy' ? builtPassives(enemyDef(combat, unit)).filter((p) => p.name !== unit.armor?.name) : [];
  const firing = planning ? timed.filter((t) => t.due) : [];
  const counters = [armorChip(unit), ...timed.filter((t) => !t.due).map(countdownChip)].filter(Boolean);
  // The sprite gives up height for each extra row this creature carries (counters, a firing ability's tag).
  return `
    <button class="unit ${unit.kind} ${unit.stolen ? 'stolen' : ''} ${targetable ? 'targetable' : ''} ${selected ? 'selected' : ''} ${fx.classes}" data-action="target" data-uid="${esc(unit.uid)}"
            data-tier="${esc(unit.kind === 'enemy' ? enemyDef(combat, unit).tier ?? '' : unit.kind)}" style="--extra-chips: ${counters.length}; --extra-tags: ${firing.length}">
      ${firing.map(timedView).join('')}
      ${intent ? intentView(combat, intent) : ''}
      <span class="figure">
        <svg class="sprite" data-sprite="${esc(sprite)}" aria-hidden="true"><use href="#sprite-${esc(sprite)}"/>${armorPieces(unit, fx)}</svg>
        ${damageNumbers(unit, hits)}
      </span>
      <span class="name">${esc(unit.name)}</span>
      <span class="vitals">
        ${unit.block ? `<span class="block-badge" aria-label="Block">${icon('shield')}<b>${unit.block}</b></span>` : ''}
        <span class="hpbar" style="--hp-frac: ${unit.maxHp ? unit.hp / unit.maxHp : 0}; --hp-from: ${unit.maxHp ? fx.prevHp / unit.maxHp : 0}">
          <span class="loss"></span><span class="fill"></span><span class="label">${unit.hp} / ${unit.maxHp}</span>
        </span>
      </span>
      ${statusChips(unit, passives, counters)}
    </button>`;
}

// Encrusted Armor: the crab's barnacles, drawn over its body from their own symbols. Each hit the armor
// softens knocks pieces off (spread evenly when the art has more or fewer pieces than the armor has hits).
// A piece that fell since the last redraw plays its fall once, then is gone.
function armorPieces(unit, fx) {
  if (!unit.armor) return '';
  const art = document.querySelectorAll(`symbol[id^="sprite-${unit.id}-armor-"]`).length;
  const on = (hitsLeft, piece) => hitsLeft * art > piece * unit.armor.hits;
  return Array.from({ length: art }, (_, piece) => {
    const href = `#sprite-${esc(unit.id)}-armor-${piece}`;
    if (on(unit.armor.hitsLeft, piece)) return `<use class="armor-piece" href="${href}"/>`;
    if (on(fx.prevArmor ?? 0, piece)) return `<use class="armor-piece shed" href="${href}"/>`;
    return '';
  }).join('');
}

// The hit counter: what the armor does, and how many hits it has left.
function armorChip(unit) {
  const { armor } = unit;
  if (!armor) return '';
  if (!armor.hitsLeft) return `<span class="chip armor broken">${esc(armor.name)}: broken</span>`;
  return `<span class="chip armor">${esc(armor.name)} ×${esc(armor.multiplier)}: ${esc(count(armor.hitsLeft, 'hit'))} left</span>`;
}

// A timed ability between firings: how long until it does.
function countdownChip(t) {
  return `<span class="chip countdown">${esc(t.name)} in ${esc(count(t.inTurns, 'turn'))}</span>`;
}

// A timed ability on the turn it fires, hung above the intent: what it does and who it lands on.
function timedView(t) {
  const amount = t.amount === null || t.amount === undefined ? '' : `<b>${esc(t.amount)}</b>`;
  return `
    <span class="intent beam">${icon('beam')}<span class="what">${esc(t.name)}</span>${amount}<span class="arrow">→</span><span class="who">${esc(t.targetName)}</span></span>`;
}

// Damage numbers show what a hit did, after it resolved: the damage past block, or "Blocked" if block took all of it.
// Several hits on one unit in the same redraw (a multi-hit attack) stagger one after another.
function damageNumbers(unit, hits) {
  return hits
    .filter((hit) => hit.targetUid === unit.uid)
    .map((hit, order) => {
      const damage = hit.damage ?? hit.hpLost;
      const blocked = !damage && hit.blocked;
      const text = damage ? `−${damage}` : blocked ? 'Blocked' : damage;
      return `<span class="damage-number ${blocked ? 'blocked' : ''}" style="--order: ${order}" aria-hidden="true">${text}</span>`;
    })
    .join('');
}

// What each intent type looks like on its tag: base numbers from data, never a computed result.
// Tags are tinted by what the intent does: harm (hurts or curses you), guard, or scheme.
const INTENT_VIEWS = {
  attack: (i) => ({ tone: 'harm', body: `${icon('sword')}<b>${esc(i.amount)}</b>${i.times ? `<span class="times">×${esc(i.times)}</span>` : ''}` }),
  devourSummon: () => ({ tone: 'harm', body: '<span class="what">Devour</span>' }),
  status: (i) => ({ tone: 'harm', body: `<span class="what">${esc(i.status)}</span><b>${esc(i.duration)}</b>` }),
  block: (i) => ({ tone: 'guard', body: `${icon('shield')}<b>${esc(i.amount)}</b><span class="what">Block</span>` }),
  blockAllies: (i) => ({ tone: 'guard', body: `${icon('shield')}<b>${esc(i.amount)}</b><span class="what">Shield allies</span>` }),
  healAllies: (i) => ({ tone: 'guard', body: `${icon('heart')}<b>${esc(i.amount)}</b><span class="what">Heal allies</span>` }),
  burrow: () => ({ tone: 'guard', body: '<span class="what">Burrow</span>' }),
  buffSelf: (i) => ({ tone: 'scheme', body: `<span class="what">${esc(i.stat)}</span><b>+${esc(i.amount)}</b>` }),
  charge: () => ({ tone: 'scheme', body: '<span class="what">Winding up</span>' }),
  idle: (i) => ({ tone: 'guard', body: `<span class="what">${esc(i.label ?? 'Waits')}</span>` }),
  summon: (i, combat) => ({ tone: 'scheme', body: `<span class="what">Calls</span><b>${esc(i.count ?? 1)}</b><span class="what">${esc(combat.data.enemiesById[i.id]?.name ?? i.id)}</span>` }),
};

function intentView(combat, intent) {
  const view = INTENT_VIEWS[intent.type]?.(intent, combat) ?? { tone: 'scheme', body: `<span class="what">${esc(intent.type)}</span>` };
  const target = intent.targetName ? `<span class="arrow">→</span><span class="who">${esc(intent.targetName)}</span>` : '';
  return `<span class="intent ${view.tone}">${view.body}${target}</span>`;
}

// Statuses with their number (Weak 2, Strength +2, Strength −1), then counters (armor, beam), then the
// enemy's standing rules.
function statusChips(unit, passives, counters = []) {
  const chips = Object.entries(unit.statuses).map(([name, status]) => {
    const value = status.amount ?? status.duration;
    const shown = value === undefined ? '' : status.amount > 0 && name === 'strength' ? ` +${value}` : ` ${String(value).replace('-', '−')}`;
    return `<span class="chip">${esc(name)}${esc(shown)}</span>`;
  });
  const traits = passives.map((passive) => `<span class="chip trait">${esc(passive.name)}</span>`);
  const all = [...chips, ...counters.filter(Boolean), ...traits];
  return all.length ? `<span class="statuses">${all.join('')}</span>` : '';
}

function outcomePanel(app) {
  const { combat, run } = app;
  const { player } = combat;
  if (combat.phase === 'won') {
    const names = combat.corpses.map((enemy) => enemy.name).join(', ');
    return outcomeView('won', 'Victory', [`Defeated: ${names}`, `Turns: ${combat.turn}`, `HP left: ${player.hp} / ${player.maxHp}`],
      '<button class="big-button" data-action="claim">Continue</button>');
  }
  if (combat.phase === 'lost') {
    const breathe = run.secondBreaths
      ? `<button class="big-button" data-action="breath-restart">Breathe again</button>
         <p class="small">Restart this fight from its first turn. Second Breaths left: ${run.secondBreaths}.</p>`
      : '<p class="small">No Second Breaths left.</p>';
    return outcomeView('lost', 'You have fallen', [`Turns survived: ${combat.turn}`],
      `${breathe}<button class="plain-button" data-action="accept-death">Accept your fate</button>`);
  }
  return '';
}

function outcomeView(kind, title, lines, buttons) {
  return `
    <div class="outcome ${kind}">
      <div class="panel">
        <h2>${esc(title)}</h2>
        ${lines.map((line) => `<p>${esc(line)}</p>`).join('')}
        <div class="actions column">${buttons}</div>
      </div>
    </div>`;
}

function logPanel(combat, ui) {
  return `
    <section class="log ${ui.logOpen ? 'open' : 'closed'}">
      <button class="log-toggle" data-action="toggle-log" aria-expanded="${ui.logOpen}">
        <span>Combat log</span><span class="toggle-word">${ui.logOpen ? 'Hide' : 'Show'}</span>
      </button>
      ${ui.logOpen ? `<div class="log-body">${combat.log.map(entryView).join('')}</div>` : ''}
    </section>`;
}

function entryView(record) {
  const { kind, title, lines } = formatEntry(record);
  const classes = kind.split(' ').map((k) => `log-${k}`).join(' '); // prefixed so they can't collide with layout classes
  return `
    <div class="log-entry ${classes}">
      <div class="log-title">${esc(title)}</div>
      ${lines.map((line) => `<div class="log-line">${esc(line)}</div>`).join('')}
    </div>`;
}

function prompt(app) {
  const { combat, ui, run } = app;
  if (ui.confirm === 'breath') return { text: `Tap Breaths again to restart this fight from its first turn. Second Breaths left: ${run.secondBreaths}.`, tone: 'warn' };
  if (ui.message) return { text: ui.message, tone: 'warn' };
  if (combat.phase !== 'player') return { text: '', tone: '' };
  const card = selectedCard(combat, ui);
  if (card) {
    const calling = ui.callShot && canCallShot(card);
    return { text: targetPrompt(card), tone: 'focus', payment: needsPayment(card), calling };
  }
  const summon = livingSummons(combat).find((s) => s.uid === ui.selectedSummonUid);
  if (summon) return { text: `Tap an enemy for ${summon.name} to attack.`, tone: 'focus' };
  const canPlayAny = combat.piles.hand.some((c) => playability(combat, cardDef(combat, c)).ok);
  if (!canPlayAny) return { text: 'Nothing left to play. End your turn.', tone: 'focus' };
  const commanding = livingSummons(combat).some((s) => s.attack);
  return { text: commanding ? 'Your turn. Tap a card, or tap a summon to pick its target.' : 'Your turn. Tap a card, or tap an enemy to learn about it.', tone: '' };
}

// "Pay X health": the player sets X here before casting. Only X is shown, never what it will become.
function paymentStepper(combat, ui) {
  const { min, max } = paymentRange(combat);
  return `
    <span class="payment">
      <span>Pay</span>
      <button class="step" data-action="pay-less" aria-label="Pay less" ${ui.payment <= min ? 'disabled' : ''}>−</button>
      <b class="amount">${ui.payment}</b>
      <button class="step" data-action="pay-more" aria-label="Pay more" ${ui.payment >= max ? 'disabled' : ''}>+</button>
      <span>health</span>
    </span>`;
}

// Call Your Shot keypad: tap the digits of the HP the attack will take, or just tap the target to skip.
// It stays on its own row while the toggle is on, so selecting a card never shifts the board under your finger.
const DIGITS = '1234567890';
function keypad(ui, calling) {
  const live = calling ? '' : 'disabled';
  return `
    <div class="keypad" aria-label="Call your shot">
      <span class="call-readout ${calling ? 'live' : ''} ${ui.call ? '' : 'empty'}" aria-label="Your call">${esc(ui.call || 'Call')}</span>
      ${[...DIGITS].map((digit) => `<button class="key" data-action="call-digit" data-digit="${digit}" ${live}>${digit}</button>`).join('')}
      <button class="key erase" data-action="call-erase" aria-label="Erase" ${calling && ui.call ? '' : 'disabled'}>⌫</button>
    </div>`;
}

function controls(app) {
  const { combat, ui } = app;
  const { draw, discard } = combat.piles;
  const { text, tone, payment, calling } = prompt(app);
  const { enabled } = combat.data.config.callYourShot;
  const callToggle = enabled
    ? `<button class="call-toggle ${ui.callShot ? 'on' : ''}" data-action="call-toggle" aria-pressed="${ui.callShot}">${icon('target')}<span>Call shot</span></button>`
    : '';
  return `
    <div class="controls">
      ${enabled && ui.callShot ? keypad(ui, calling) : ''}
      <div class="pile" aria-label="Draw pile"><b>${draw.length}</b><span>Draw</span></div>
      <div class="prompt ${tone}" role="status">${payment ? paymentStepper(combat, ui) : ''}<span>${esc(text)}</span></div>
      ${callToggle}
      <div class="pile" aria-label="Discard pile"><b>${discard.length}</b><span>Discard</span></div>
      <button class="big-button end-turn" data-action="end-turn" ${combat.phase === 'player' ? '' : 'disabled'}>End turn</button>
    </div>`;
}

function hand(combat, ui) {
  return `<div class="hand">${combat.piles.hand.map((instance) => {
    const card = cardDef(combat, instance);
    const check = playability(combat, card);
    // Why a card can't be played is printed on it, except for energy and turn, which the HUD already shows.
    const showReason = !check.ok && check.kind !== 'energy' && check.kind !== 'turn';
    const selected = ui.selectedUid === instance.uid;
    const call = selected && ui.callShot && canCallShot(card) ? ui.call : undefined;
    return cardFace(card, {
      action: 'card', uid: instance.uid, selected, dim: !check.ok, reason: showReason ? check.reason : null,
      mods: cardModifiers(combat, card), call,
    });
  }).join('')}</div>`;
}
