# DUNGEON RUN — Art Direction

**Read this before writing any CSS or SVG, in every phase. Not just the first one.**

Also read `/mnt/skills/public/frontend-design/SKILL.md` before the first styling pass.

---

## 0. THE FAILURE MODE

The default output for "dark fantasy card game" is a generic dark-mode web app: Tailwind grays, Inter, uniformly rounded corners, a purple gradient somewhere, lots of even spacing. **Do not build that.**

This is a dungeon. Wet stone, torchlight, iron, dirt, and something rotting in the next room. Every visual decision should trace back to that, not to a component library.

Before calling any phase done: look at the screen and ask whether it could be mistaken for a default template. If the answer is *maybe*, it isn't done.

---

## 1. LIGHT IS THE MOOD

This matters more than any other rule here.

The screen should feel **lit by torches**, not backlit by an LCD.

- Warm pools of light with deep, fast falloff into near-black.
- No flat, even illumination anywhere on the screen. Ever.
- A faint, slow flicker on torch-colored accents — low amplitude, irregular timing. It should be felt, not watched.
- Important things are lit. Unimportant things fall into shadow. Use light as hierarchy instead of font size wherever possible.
- Radial gradients and layered `box-shadow` do this work. Large soft warm shadows for the pools, hard dark insets for the recesses.

---

## 2. TYPOGRAPHY

There are no image assets in v1, so **type carries the entire identity.**

- Two typefaces from Google Fonts, both with real character.
  - **Display** — a weathered, high-contrast, or blackletter-adjacent serif. Card names, enemy names, screen titles. Should read as stamped, inked, or carved.
  - **Text** — plain and highly legible. Numbers, card rules text, UI. This one gets out of the way.
- **Never a default system font stack.** Never Inter, Roboto, or Helvetica as the display face.
- Card rules text must be dead legible at arm's length on an iPad. The display face is for names only — do not set body copy in it.
- Numbers are the game. Damage, HP, energy, cost: give them weight, tabular figures, and enough size that the player can do arithmetic at a glance without squinting.

---

## 3. TEXTURE, NOT GRADIENTS

Flat fills and simple linear gradients read as cheap. Build surfaces.

- Rough stone and old vellum, suggested with CSS: layered `box-shadow`, `inset` shadows, subtle noise from repeating gradients or an inline SVG `feTurbulence` filter.
- Edges should feel worn. Avoid uniform `border-radius` on everything — irregularity reads as handmade.
- Surfaces sit at different depths. The board is recessed; cards sit on top of it; modals sit above everything with real shadow separating them.

---

## 4. CARDS

Cards are pages torn from a forbidden book. They should have weight.

- Visible frame with inset borders. Aged card-stock color, not white, not gray.
- School identity carried by a colored edge, sigil, or inner glow — pulled from `config.json`:
  - **Necromancy** — sickly green
  - **Darkhold** — deep violet
  - **Elemental** — pale gold
  - **Neutral** — bone / parchment
  - **Curses** — no color. Dead. Ashen and unappealing on purpose.
- Energy cost is the most prominent element after the name. It's the number the player checks most.
- Rarity is visible at a glance without reading: frame treatment, not a text label.
- Unplayable cards (insufficient energy, `requires` unmet) are visibly dimmed and desaturated, not just non-interactive.

---

## 5. ENEMIES

Inline SVG, drawn with intent. A strong silhouette beats detail every time.

- Each enemy needs one memorable shape. If you can't recognize it as a black silhouette, redraw it.
- Scale communicates threat. The Corrupted Crab should be genuinely imposing next to a Dungeon Rat — not the same box with a different glyph.
- Enemies breathe. A slow idle animation, barely perceptible. Static sprites read as broken.
- Intent is displayed above each enemy and is always readable: icon plus number plus target. The player plans around this, so it is never decorative and never ambiguous.

---

## 6. MOTION

Fast and physical. The game must feel quick.

- **Nothing over 400ms.** The one exception is ambient idle loops (torch flicker, breathing): they respond to nothing the player does, so they may be slow. Everything that reacts to a tap stays under 400ms.
- Damage numbers punch out, rise, and fall away.
- Screen shakes briefly when the player takes damage. Scale the shake to the damage.
- Health bars **drain** over ~250ms. They never jump.
- Card play: the card moves to the target and resolves. Don't just make it disappear.
- Restraint everywhere else. Menus, transitions, and hovers stay still. Motion means *something happened*.
- Respect `prefers-reduced-motion`.

---

## 7. LAYOUT

- **Dense and tactile, not airy.** This is a dungeon, not a SaaS dashboard. Tighten the spacing. Let elements touch. Let it feel cramped and underground.
- Touch targets 44px minimum regardless of density.
- Works in portrait and landscape on iPad. Landscape is the primary.
- The combat log is present but subordinate — collapsible, legible, never competing with the board.

---

## 8. DESIGN TOKENS

After the first styling pass, extract every color, shadow, type scale, spacing step, and timing value into `/styles/tokens.css` as custom properties.

**Every later phase uses those tokens and adds to them rather than inventing new values.** This is what prevents phases 2 through 6 from drifting into five different-looking games.

Palette source of truth is `config.json`. Tokens derive from it.

---

## 9. CHECK BEFORE EVERY PHASE IS DONE

- [ ] Could not be mistaken for a default dark-mode template
- [ ] Lit by torches — no flat, evenly-lit regions
- [ ] Display typeface has character; no system font stack
- [ ] Surfaces have texture and depth, not flat fills
- [ ] Card school is identifiable without reading the text
- [ ] Enemy silhouettes are distinct and scaled to threat
- [ ] Nothing animates longer than 400ms (ambient idle loops excepted)
- [ ] All new values added to `tokens.css`, none hardcoded in component CSS
- [ ] Readable at arm's length on an iPad
