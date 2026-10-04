# DUNGEON RUN — Build Specification v1.0

A turn-based roguelike deckbuilder. You are a sorcerer with a forbidden book of magic, descending into the king's dungeon to free the kingdom from evil.

Designed by Ben. Spec written for handoff to Claude Code.

---

## 0. PRIME DIRECTIVE FOR THE BUILDER

**Ship a playable game before you ship a complete one.**

Build in this order. Do not proceed to the next phase until the previous one is playable on an iPad.

| Phase | Deliverable | Done when |
|---|---|---|
| 1 | One fight. Player vs. Dungeon Rat. Draw, play cards, deal damage, win or lose. | Ben can beat a rat on his iPad. |
| 2 | Summons + Reanimate + enemy targeting. | Ben can raise a dead rat and watch it fight. |
| 3 | Map, 9 nodes, branching paths, gold, shop, rest. | Ben can complete a full run. |
| 4 | Companions, sacrifice, Golden Light, Call Your Shot. | All signature systems live. |
| 4b | Events + the two minigames. | Ben can win or lose a run at the Blood Wager. |
| 5 | Corrupted Crab boss. | Ben can win. |
| 6 | PWA, offline, home screen icon, GitHub Pages deploy. | Ben can send the URL to a friend. |

Phase 1 should take one session. If it doesn't, cut something.

---

## 1. TECH

- **Vanilla HTML / CSS / JavaScript.** ES modules. No framework, no build step, no bundler, no npm install.
- **Single page app.** `index.html` + `/src` modules + `/data` JSON.
- **Deploy:** GitHub Pages, served from repo root or `/docs`. Must work when opened as a static file.
- **PWA:** `manifest.json` + service worker caching all assets. Must launch full-screen from the iPad home screen and run with no network.
- **Storage:** `localStorage` for unlocks, settings, best run, and in-progress run state. No backend, no accounts.
- **Art:** CSS and inline SVG only. No image files. Card frames, icons, and enemy sprites are drawn with CSS gradients, borders, and SVG glyphs. Art is explicitly Depth 2.
- **Target:** iPad Safari, touch-first, works in portrait and landscape. Tap targets ≥ 44px. No hover-dependent interactions. No drag-and-drop required — tap card, tap target.

### File layout

```
/index.html
/manifest.json
/sw.js
/src
  main.js          — boot, screen router
  state.js         — single run-state object, save/load
  combat.js        — turn loop, damage resolution, status effects
  summons.js       — summon lifecycle, enemy targeting
  cards.js         — card effect dispatcher
  map.js           — node generation, branching, progression
  shop.js          — shop, rest, shrine, event nodes
  render.js        — DOM rendering, animation
  log.js           — combat log (math breakdown)
/data
  config.json      — global tuning numbers
  cards.json       — every card
  enemies.json     — every enemy, elite, boss, encounter table
  companions.json  — companions and their sacrifices
  events.json      — events and minigames
  relics.json      — relics
/styles
  main.css
```

### Data-driven, non-negotiable

**Zero gameplay numbers live in `/src`.** Every cost, damage value, HP total, scaling factor, and drop rate lives in `/data/*.json`. The engine reads data and executes effects by keyword.

This is the most important architectural rule in the spec. Ben tunes his own game by editing JSON — no code, no rebuild, no waiting. If a number is hardcoded in a `.js` file, it is a bug.

Effects are declarative keyword objects, not code strings:

```json
{ "type": "damage", "target": "enemy", "amount": 6 }
{ "type": "block", "amount": 5 }
{ "type": "summon", "id": "skeleton" }
{ "type": "payHealth", "variable": true }
```

Add a new keyword to the dispatcher once; reuse it across any number of cards.

---

## 2. CORE LOOP

### Run structure
- 13 map nodes, branching paths, boss at the end. *(Was 8–10; lengthened by the producer, Oct 2026: one more elite, two more fights, one more event.)*
- Target run length: **12–18 minutes.**
- Permadeath. No continues. No undo.
- **Second Breath:** 3 per run. Restarts the *current fight* from its starting state (HP, deck, and hand as they were when the fight began). When they're gone, they're gone. Spending one is a real cost — this is deliberate design, not a cheat. Display the remaining count prominently.
- Every death unlocks something: a new card enters the pool, or a new enemy variant, or a relic. The death screen must show a run summary **and** the unlock. The player never walks away with nothing.

### Depth tiers (difficulty)
Opt-in, ascension-style. Depth 0 is the default. Each tier adds one modifier (enemies +15% HP, start with a curse, fewer rest nodes, elite deals +25%). Unlock the next tier by beating the current one. Player chooses their own punishment.

### Combat turn order
1. **Start of player turn** — block resets to 0; draw to 5 cards; energy resets to 3; tick down status durations.
2. **Player acts** — play any number of cards while energy remains. End turn when ready.
3. **Summons act** — in the order they were summoned; each attacks its assigned target.
4. **Enemies act** — resolve their telegraphed intent.
5. **End of turn** — end-of-turn effects (burn, Darkhold Pact damage) resolve; hand discards.

### Energy and hand
- 3 energy per turn. Hand size 5. Unplayed cards discard at end of turn.
- Draw pile shuffles from discard when empty.
- Starting deck is 10 cards (see `cards.json`).

### Intent telegraphing
Every enemy shows its next action **and its target** above its sprite before the player acts: `⚔ 9 → Skeleton`. This is mandatory. Call Your Shot and all summon strategy depend on the player being able to compute outcomes exactly. Nothing is hidden random in combat.

---

## 3. DAMAGE MATH

Resolve in this exact order. The combat log must show each step.

```
raw        = card base damage
+ Strength (flat, per attack)
× 0.75     if attacker is Weakened
× 1.50     if target is Marked (vulnerable)
− target block
= HP lost
```

Round down at every step. Block absorbs before HP. Leftover block is destroyed at the start of the player's next turn.

### Status effects

| Name | Effect | Default duration |
|---|---|---|
| **Strength** | +X damage per attack | Permanent for the fight |
| **Weak** | Attacker deals 25% less | 2 turns |
| **Mark of Rot** | Target takes 50% more | 2 turns |
| **Burn** | X damage at end of turn | 3 turns |
| **Frail** | Block gained reduced 25% | 2 turns |

### Combat log
A scrolling log panel shows the arithmetic for every hit:

```
Thunderbolt → Cave Bat
  9 base + 2 Strength = 11
  × 1.5 (Marked) = 16
  − 4 block = 12 damage
  Cave Bat: 16 → 4 HP
```

**The log shows the breakdown AFTER resolution. Card text shows base numbers and active modifiers separately. The UI never pre-computes the final damage number for the player.** If the player wants to know what a card will do before playing it, they do the math. This is intentional and was a parent-level design requirement.

---

## 4. CALL YOUR SHOT

Opt-in prediction mechanic. The reason the player does the math is that it pays.

- Before playing an attack card, the player may tap **Call Your Shot** and enter a predicted final damage number.
- If the prediction matches actual HP lost exactly: **+1 energy at the start of next turn.**
- If wrong: nothing happens. No penalty.
- **Maximum 1 bonus per turn.** Prevents grinding it on trivial attacks.
- Fully optional. A player who never touches it can still win. A player who uses it well is meaningfully stronger.
- UI: a small numeric input that appears on attack cards when the toggle is on. Must be one tap to use and one tap to skip. If it slows the game down, it has failed.

---

## 5. SUMMONS

Summons are the signature mechanic. They exist for exactly one fight.

- Each summon has **current HP** and **attack**. Both come from data.
- Summons act after the player, before the enemies.
- Summons die at 0 HP. **All summons vanish when the fight ends.** They never persist between fights.
- Maximum 4 summons on the board. Summoning past the cap replaces the oldest.
- Summons can be targeted, buffed, sacrificed, and stolen.

### Enemy targeting rule — DETERMINISTIC

> **If any summon is alive, enemies attack the summon with the highest current HP. Otherwise they attack the player.**
>
> Exception: an enemy with `"ignoresSummons": true` always attacks the player.

No randomness. This is deliberate — it makes summons a controllable lightning rod and it lets the player plan. Managing which summon is the biggest becomes real skill expression.

### Reanimate — locked card

> **Reanimate** — Cost 1
> Pay X health. Raise the last enemy that died this fight as a summon with **2X HP**.
> It attacks for **half its original attack, rounded down.**
> Cannot be played if nothing has died this fight.

Design notes, for anyone tempted to "fix" this: the half-attack clause exists so that killing a huge enemy doesn't hand the player a huge ally. The 2:1 HP return exists because 1:1 was tested in design and judged a bad trade. The card is intentionally dead in the opening hand.

---

## 6. COMPANIONS

Permanent allies, found through events, elites, and rescues. Maximum **2 at a time**.

- Companions do not fight and cannot be killed. They are passive run-shaping modifiers.
- Each companion changes how the whole deck works. Picking one is a strategic commitment.
- **Sacrifice:** the player may destroy a companion at any time for one large one-time effect. The passive is lost permanently for the rest of the run. This is a real button in the UI, always available, always costly.
- Taking a third companion requires dismissing or sacrificing one.

Companion definitions live in `companions.json`.

---

## 7. THE THREE SCHOOLS

Cards come from a forbidden book. Three schools, each with a distinct feel.

**Necromancy** — you don't fight alone. Raise bodies, buff them, spend them. Board-state school. Strong over long fights, weak in burst.

**Darkhold** — you take. Life, souls, energy. Nearly every card costs you something: HP, max HP, cards, or future turns. Highest ceiling, highest risk.

**Elemental** — raw, clean damage and shields. No tricks. The reliable school. Thunderbolt, Mana Shield, Lifebolt.

Cards are tagged by school in data. Card frame color is driven by school tag.

### Golden Light — locked card

> **Golden Light** — Cost 1
> Pay 20 gold **and** X health. Deal **X × 3** damage to one enemy.

Payment to the gods. Strong when the player has HP to burn, catastrophic when they don't. The HP is paid up front, deliberately — scaling off *missing* HP would reward the player for being nearly dead, which is backwards.

---

## 8. MAP

13 nodes, branching. The player chooses between 3–4 paths at each split. Each lane has a character (`config.json` `map.laneThemes`): one leans on elites, one on fights, one on events, one is a mix. *(Changed by the producer, Oct 2026.)*

| Node | Behavior |
|---|---|
| **Combat** | Standard fight. 1–3 enemies. Reward: gold + card choice (pick 1 of 3). |
| **Elite** | Hard fight. Reward: a relic, more gold, and better odds on the cards offered. Sometimes a companion. |
| **Shop** | Spend gold on cards, relics, card removal. |
| **Rest** | Heal 30% max HP, **or** upgrade a card. Not both. |
| **Event** | A room, a choice, a cost. Some events are skill-based minigames. See `events.json`. |
| **Treasure** | Free relic. |
| **Boss** | Corrupted Crab. Big open room. |

### Path and pacing rules
- The player always chooses between 2–3 forward paths. Paths must visibly diverge and reconverge, so the choice is legible at a glance.
- Node types are shown on the map before the player commits. No blind picks.
- **3 elites** exist in the pool (Iron Torturer, The Questioner, The Kennel Master). An elite-heavy lane can hold several; taking it is an opt-in risk, never forced: there is always a lane that leans on ordinary fights. *(Was 2 elites, at most one per path; changed by the producer, Oct 2026.)*
- Guarantee at least one **Rest** in the back half of the map.
- Guarantee the node before the boss is a **Rest** or **Shop**.
- Guarantee at least one **Event** per run.
- Fight difficulty scales with depth: nodes 1–3 draw from `easy`, 4–8 from `medium`, 9+ from `hard`.

### Events

Full definitions in `events.json`. Two hard design rules, enforced:

1. **Both options must cost something.** An event where one choice is strictly better is not an event, it is a free reward. If a choice has no downside, it is unfinished.
2. **Minigames must be fast and skill-based.** 60 seconds maximum. The player should lose because they played badly, not because of a dice roll. If a minigame drags, cut it.

Two minigames in v1:
- **Memory Match** (The Dealer's Table) — 12 cards, 6 pairs, 16 flips. Beatable with attention, unwinnable by guessing.
- **Push Your Luck** (The Blood Wager) — pay HP per round for escalating prizes, with escalating odds of losing everything staked. Expected value deliberately turns negative at round 4, so a player who does the math stops at 3 and a player who wants the rare relic gambles anyway. That tension is the entire event.

---

## 9. THE BOSS

> ### CORRUPTED CRAB — 120 HP
> A crab the size of a cart, with a magic shard fused into its shell. The shard is what's wrong with it.
>
> **Encrusted Armor** — Takes **half damage from the first 5 hits** of the fight. Count **hits, not damage.** After 5 hits the barnacles fall off and the armor breaks permanently. Play a visible barnacle-shedding animation and a hit counter.
>
> **Corrupting Beam** — Every **3 turns**, the shard fires. It **steals** one of the player's summons **permanently**: the summon crosses over and fights for the crab with the HP and attack it had. The player's other summons stay. Killed, it leaves no corpse: not recoverable. If the player has **no summons**, the beam hits the player for **18 damage.** *(Stealing, rather than erasing, clarified by the producer, Oct 2026.)*
>
> **Barnacle minions** — Once its armor breaks, the crab summons barnacles during the fight; while the armor holds, they cling to its shell. They can be killed, and they can be Reanimated. When the crab dies the fight is over: its minions fall with it. *(No barnacles before the armor breaks: producer, Oct 2026.)*

The fight is a duel over the same bodies. The crab takes the player's summons; the crab also provides corpses to raise. There is no hiding from the beam — refusing to summon just means eating 18 to the face every third turn.

Counting hits rather than damage is a deliberate guard: if Encrusted Armor keyed off damage, a single Golden Light would erase the mechanic.

---

## 10. UI REQUIREMENTS

- Hand of cards along the bottom, tap to select, tap target to play.
- Enemy intents always visible, always including target.
- Summons rendered on the player's side with HP bars.
- Persistent HUD: HP, block, energy, gold, Second Breaths remaining, companions.
- Combat log panel — collapsible, scrollable, shows all math.
- Everything readable at arm's length on an iPad. Large type. High contrast. The dungeon is wet stone, torchlight, and dirt: dark palette, warm torch accents, sickly green for Necromancy, deep violet for Darkhold, pale gold for Elemental.
- No animations longer than 400ms. The game must feel fast. (Ambient idle loops such as torch flicker and enemy breathing are exempt; see DESIGN.md section 6.)

---

## 11. DEPTH 2 — PARKED, NOT KILLED

Do not build these in v1. They are real and they are coming.

- Demonic strength buff on raised summons
- More schools, more companions
- Multiple bosses and a second dungeon floor
- Card art
- Daily seeded runs
- A second playable character

---

## 12. DEFINITION OF DONE

- [ ] Full run completable start to boss on an iPad
- [ ] Added to home screen, launches full-screen, runs offline
- [ ] All gameplay numbers editable in `/data` with no code changes
- [ ] Combat log shows arithmetic for every hit
- [ ] Call Your Shot works and pays out
- [ ] Reanimate, Golden Light, sacrifice, and Corrupting Beam all function as specified
- [ ] Death screen shows run summary and an unlock
- [ ] Deployed to GitHub Pages with a shareable URL
