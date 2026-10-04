// Shop and rest nodes.
// Prices, heal amounts and stock size all come from data/config.json ("shop", "rewards").
// Event nodes and their minigames live in events.js. Relics aren't for sale yet (only events give them).

import { canUpgrade, rollCards } from './cards.js';
import { floorMul, newCard, randomInt } from './state.js';

const refused = (reason) => ({ ok: false, reason });

// ---------------------------------------------------------------------------
// Shop: cards for sale at a price each, and one card removal per visit.

export function openShop(data) {
  const { shop } = data.config;
  return {
    stock: rollCards(data, shop.cardsForSale).map((id) => ({ id, price: randomInt(shop.cardPrice), sold: false })),
    removalPrice: shop.cardRemovalPrice,
    removalUsed: false,
  };
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
