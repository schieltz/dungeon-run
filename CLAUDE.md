# DUNGEON RUN

A turn-based roguelike deckbuilder. You play a sorcerer with a forbidden book of magic, descending into the king's dungeon to free the kingdom from evil.

**Designed by Ben.** The design is his — treat it that way.

---

## READ FIRST, EVERY SESSION

- **`SPEC.md`** — the authority on everything. Mechanics, math, architecture, phase plan.
- **`DESIGN.md`** — art direction. A requirement, not a suggestion. Re-read it at the start of every phase.

Content data lives in `/data`: `config.json`, `cards.json`, `enemies.json`, `companions.json`, `events.json`.

---

## THE THREE RULES

**1. Build in phases. Do not build ahead.**
`SPEC.md` Section 0 has the phase table. Finish a phase, stop, let the designer test it on his iPad. A half-finished everything is worth less than a finished something. If you find yourself building the map during the combat phase, stop.

**2. Zero gameplay numbers in `/src`.**
Every cost, damage value, HP total, scaling factor, and drop rate is read from `/data/*.json`. A number hardcoded in a `.js` file is a bug, not a shortcut.

This is the most important architectural rule in the project. The designer tunes this game by editing JSON — no code, no rebuild, no waiting on anyone. The engine exists to serve that.

**3. Card and enemy effects are declarative keyword objects, dispatched by the engine.**
Never code strings, never a `switch` on card ID. Adding a card must be a data change only.

---

## CONSTRAINTS

- Vanilla HTML / CSS / JS. ES modules. **No framework, no build step, no bundler, no npm install.** It runs by opening `index.html`.
- Target: **iPad Safari.** Touch-first. Tap card, tap target. No drag-and-drop, no hover-dependent interaction. 44px minimum tap targets. Portrait and landscape.
- No image assets. CSS and inline SVG only.
- Deploys to GitHub Pages as a PWA. Must launch full-screen from the home screen and run offline.

---

## DESIGN DECISIONS THAT ARE LOCKED

These were argued through during design. They are not bugs and they are not oversights. Do not "fix" them without being asked.

- **Reanimate's half-attack clause** exists so that killing a huge enemy doesn't hand the player a huge ally. The 2:1 HP return was tested at 1:1 in design and judged a bad trade.
- **Golden Light charges HP up front.** Scaling off *missing* HP would reward the player for being nearly dead. Backwards.
- **Encrusted Armor counts hits, not damage.** If it keyed off damage, a single Golden Light would erase the mechanic.
- **Enemy targeting is deterministic** — highest-HP summon, else the player. Not random. Determinism is what makes summons a controllable lightning rod and makes Call Your Shot possible.
- **The combat log shows arithmetic after resolution. The UI never pre-computes expected damage before the player commits.** This is a deliberate parent-level requirement. The player does the math.
- **The Questioner is an elite, not a basic enemy.** A curse-giver in an early fight ends runs before the player has a deck that can race it.
- **Both options in every event must cost something.** An event where one choice is strictly better is a free reward, not an event.

---

## SCOPE

The "Depth 2" list in `SPEC.md` Section 11 is parked work: more schools, more bosses, card art, a second character. **Do not build any of it.** It is real and it is coming, but not in v1.

New ideas during a session go on that list. They do not go in the build.
