// Shop and rest nodes.
// Prices, heal amounts and stock size all come from data/config.json ("shop", "rewards").
// Event nodes and their minigames live in events.js.

import { canUpgrade, rollCards } from './cards.js';
import { floorMul, newCard, pickWeighted, randomInt } from './state.js';
import { rollRelic, runEffects, takeRelic } from './events.js';

const refused = (reason) => ({ ok: false, reason });

// ---------------------------------------------------------------------------
// Shop: cards for sale at a price each, a shelf of relics priced by rarity, and one card removal per visit.

export function openShop(data, run) {
  const { shop } = data.config;
  return {
    stock: rollCards(data, shop.cardsForSale).map((id) => ({ id, price: randomInt(shop.cardPrice), sold: false })),
    relics: shelfRelics(data, run),
    removalPrice: shop.cardRemovalPrice,
    removalUsed: false,
  };
}

// Different relics, none you carry and none an event keeps for itself (rollRelic skips those).
function shelfRelics(data, run) {
  const { shop } = data.config;
  const shelf = [];
  for (let slot = 0; slot < shop.relicsForSale; slot++) {
    const taken = { relics: [...(run?.relics ?? []), ...shelf.map((item) => item.id)] };
    const id = rollRelic(taken, data, pickWeighted(shop.relicRarityWeights));
    if (!id) break;
    shelf.push({ id, price: randomInt(shop.relicPrice[data.relicsById[id].rarity]), sold: false });
  }
  return shelf;
}

export function buyRelic(run, data, shop, index) {
  const item = shop.relics?.[index];
  if (!item || item.sold) return refused('That relic is sold.');
  if (run.relics.includes(item.id)) return refused('You already carry that.');
  if (run.gold < item.price) return refused('Not enough gold.');
  run.gold -= item.price;
  takeRelic(run, data, item.id);
  item.sold = true;
  return { ok: true };
}

export function buyCard(run, shop, index) {
  const item = shop.stock[index];
  if (!item || item.sold) return refused('That card is sold.');
  if (run.gold < item.price) return refused('Not enough gold.');
  run.gold -= item.price;
  run.deck.push(newCard(item.id));
  run.stats.cardsAdded += 1;
  item.sold = true;
  return { ok: true };
}

export function removeCard(run, shop, uid) {
  if (shop.removalUsed) return refused('This shop has already removed a card.');
  if (run.gold < shop.removalPrice) return refused('Not enough gold.');
  if (!run.deck.some((card) => card.uid === uid)) return refused('That card is not in your deck.');
  run.gold -= shop.removalPrice;
  run.deck = run.deck.filter((card) => card.uid !== uid);
  shop.removalUsed = true;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rest: heal a share of max HP, or upgrade one card. Not both.

export const restHealAmount = (run, data) => floorMul(run.player.maxHp, data.config.rewards.restHealPercent);

export function restHeal(run, data) {
  run.player.hp = Math.min(run.player.maxHp, run.player.hp + restHealAmount(run, data));
  return { ok: true };
}

export function upgradeCard(run, data, uid) {
  const instance = run.deck.find((card) => card.uid === uid);
  if (!instance || !canUpgrade(data, instance)) return refused("That card can't be upgraded.");
  instance.upgraded = true;
  return { ok: true };
}

// A card can bring its own rest action (the Bound Wood Sapling's Nurture, "atRest" in cards.json), taken
// instead of resting or upgrading.
export function restActions(run, data) {
  const ids = [...new Set(run.deck.map((card) => card.id))];
  return ids.filter((id) => data.cardsById[id]?.atRest).map((id) => ({ cardId: id, ...data.cardsById[id].atRest }));
}

export function takeRestAction(run, data, cardId) {
  const card = data.cardsById[cardId];
  if (!card?.atRest || !run.deck.some((instance) => instance.id === cardId)) return refused('Nothing here to do that with.');
  return { ok: true, results: runEffects(run, data, card.atRest.effects, card.name) };
}
