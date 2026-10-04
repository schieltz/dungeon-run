// Combat log: the math breakdown.
// combat.js records what happened; this turns each record into a title and the lines of arithmetic under it.
// Everything here describes a hit after it resolved. Nothing in the UI predicts damage before a card is played.

const signed = (n) => (n < 0 ? `− ${-n}` : `+ ${n}`);
const PLURAL = new Intl.PluralRules('en');
const count = (n, word) => `${n} ${word}${PLURAL.select(n) === 'one' ? '' : 's'}`;

function multiplierLines(steps) {
  return steps.map((step) => (step.immune ? `${step.label}: no damage` : `× ${step.multiplier} (${step.label}) = ${step.value}`));
}

// "Weak 2" for a timed status, "Strength +2" for an amount, "Burn 3 for 3 turns" for both.
function statusText(e) {
  const label = e.name.charAt(0).toUpperCase() + e.name.slice(1);
  if (e.amount !== undefined && e.duration !== undefined) return `${label} ${e.amount} for ${e.duration} turns`;
  if (e.amount !== undefined) return `${label} ${signed(e.amount).replace(' ', '')}`;
  if (e.duration !== undefined) return `${label} ${e.duration}`;
  return label;
}

// "9 base + 2 Strength = 11" as in the spec. A companion's bonus to the base gets its own line first,
// and Golden Light shows where its base came from ("6 health × 3 = 18 base").
function hitLines(e) {
  const origin = e.detail ? `${e.detail} = ${e.base} base` : `${e.base} base`;
  const bonus = e.bonus ? [`${origin} + ${e.bonus.amount} ${e.bonus.label} = ${e.afterBonus}`] : [];
  const start = e.bonus ? e.afterBonus : origin;
  const first = e.strength ? `${start} ${signed(e.strength)} Strength = ${e.afterStrength}` : e.bonus ? null : origin;
  const blockLeft = e.blockAfter ? ` (${e.blockAfter} block left)` : '';
  return [
    ...bonus,
    ...(first ? [first] : []),
    ...multiplierLines(e.steps),
    `− ${e.blocked} block = ${e.damage ?? e.hpLost} damage${blockLeft}`,
    `${e.targetName}: ${e.hpBefore} → ${e.hpAfter} HP`,
  ];
}

const DEATH_LINES = {
  player: () => 'You have fallen.',
  enemy: (name) => `${name} dies.`,
  summon: (name) => `${name} crumbles to dust.`,
};

const FORMATS = {
  turn: (e) => ({ kind: 'turn', title: `Turn ${e.turn}`, lines: [] }),
  phase: (e) => ({ kind: 'phase', title: e.text, lines: [] }),
  info: (e) => ({ kind: 'info', title: e.text, lines: [] }),
  hit: (e) => ({ kind: `hit by-${e.attackerKind}`, title: `${e.source} → ${e.targetName}`, lines: hitLines(e) }),
  block: (e) => ({
    kind: 'block',
    title: `${e.source} → ${e.targetName}`,
    lines: [
      ...(e.detail ? [`${e.detail} = ${e.base}`] : []),
      ...(e.steps.length ? [`${e.base} base`, ...multiplierLines(e.steps)] : []),
      `+ ${e.gained} block (${e.before} → ${e.after})${e.persists ? ', kept next turn' : ''}`,
    ],
  }),
  status: (e) => ({ kind: 'status', title: `${e.source} → ${e.targetName}`, lines: [statusText(e)] }),
  lose: (e) => ({ kind: 'pay', title: `${e.source}: ${e.targetName === 'You' ? 'you lose' : `${e.targetName} loses`} ${e.amount} HP`, lines: [`${e.targetName}: ${e.before} → ${e.after} HP`] }),
  maxhp: (e) => ({ kind: 'pay', title: `${e.source}: you lose ${e.amount} max HP`, lines: [`Max HP: ${e.before} → ${e.after}`] }),
  heal: (e) => ({
    kind: 'heal',
    title: `${e.source} → ${e.targetName}`,
    lines: [`Heal ${e.amount}: ${e.before} → ${e.after} HP${e.after - e.before < e.amount ? ' (max)' : ''}`],
  }),
  pay: (e) => ({
    kind: 'pay',
    title: `${e.source}: you pay ${e.amount} health`,
    lines: [`You: ${e.before} → ${e.after} HP`],
  }),
  raise: (e) => ({
    kind: 'raise',
    title: `${e.source} → ${e.corpseName}`,
    lines: [
      `${e.payment} health × ${e.hpMultiplier} = ${e.hp} HP`,
      `${e.baseAttack} attack × ${e.attackMultiplier} = ${e.attack} attack${e.attack !== e.baseAttack * e.attackMultiplier ? ' (rounded down)' : ''}`,
      `${e.name} rises.`,
    ],
  }),
  summon: (e) => ({ kind: 'raise', title: `${e.source} → ${e.name}`, lines: [`${e.hp} HP, ${e.attack} attack`] }),
  death: (e) => ({ kind: 'death', title: DEATH_LINES[e.unitKind](e.name), lines: [] }),
  call: (e) => ({
    kind: `call ${e.exact ? 'won' : 'lost'}`,
    title: `${e.source}: you called ${e.call}`,
    lines: [e.exact
      ? (e.paid ? `Exactly ${e.actual}. +${e.reward} energy next turn.` : `Exactly ${e.actual}, but you've had this turn's bonus.`)
      : `It took ${e.actual}. No bonus, no harm.`],
  }),
  armor: (e) => ({
    kind: 'armor',
    title: e.hitsLeft
      ? `${e.targetName}'s ${e.name}: ${count(e.hitsLeft, 'hit')} left`
      : `${e.targetName}'s ${e.name} breaks. The barnacles fall away.`,
    lines: [],
  }),
  timed: (e) => ({ kind: 'timed', title: `${e.byName}: ${e.name}!`, lines: [] }),
  taken: (e) => ({
    kind: 'taken',
    title: `${e.source} steals ${e.name}.`,
    lines: e.thrall ? [`It fights for ${e.byName} now, as ${e.thrall}.`] : ['Gone for good. Nothing left to raise.'],
  }),
  outcome: (e) => ({ kind: `outcome ${e.won ? 'won' : 'lost'}`, title: e.won ? 'Victory.' : 'Defeat.', lines: [] }),
};

export function formatEntry(entry) {
  const format = FORMATS[entry.kind];
  return format ? format(entry) : { kind: 'info', title: entry.text ?? entry.kind, lines: [] };
}
