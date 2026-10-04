# Dungeon Run

A turn-based roguelike deckbuilder. You are a sorcerer with a forbidden book of magic, descending into the king's dungeon.

**Play:** https://schieltz.github.io/dungeon-run/

On an iPad or iPhone, open that link in Safari, tap **Share**, then **Add to Home Screen**. It launches full-screen like an app and plays with no internet once it has loaded once.

## How it's made

- Plain HTML, CSS and JavaScript. No framework, no build step: the files in this folder are the game.
- Every number in the game lives in [`/data`](data): cards, enemies, companions, events, relics, and the tuning dials in `config.json`. Change a number, reload, and the game changes. No code needed.
- [`SPEC.md`](SPEC.md) is the design. [`DESIGN.md`](DESIGN.md) is the art direction.

## Run it on your own computer

```bash
python3 serve.py
```

Then open http://localhost:8000. (Opening `index.html` directly won't work: browsers won't load the `/data` files from a plain file.)
