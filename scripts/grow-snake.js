'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROUTE_FILE = process.env.ROUTE_FILE || 'route.json';
const OUT = process.env.SNAKE_OUT || 'dist-snake';

const CELL = 16;
const DOT = 12;
const RADIUS = 3;
const PAD = 8;
const ROWS = 7;
const STEP_SECONDS = 0.1;
const PAUSE_STEPS = 25;

const PALETTES = {
  light: {
    dots: ['#ebedf0', '#d9c8ff', '#b48cff', '#9945ff', '#14f195'],
    snake: '#9945ff',
    head: '#7a2fe0',
    eye: '#ffffff',
  },
  dark: {
    dots: ['#161b22', '#3b2a6e', '#6c3fc4', '#9945ff', '#14f195'],
    snake: '#14f195',
    head: '#5dffbf',
    eye: '#0d1117',
  },
};

function simulate(route) {
  const trail = route.trail;
  const initial = route.initialLength;
  const levelAt = new Map(route.cells.map((cell) => [`${cell.x},${cell.y}`, cell.level]));
  const chainSteps = trail.length - (initial - 1);

  const headIndex = [];
  const length = [];
  const eatenAt = new Map();
  let eaten = 0;
  for (let s = 0; s < chainSteps; s++) {
    const index = initial - 1 + s;
    const key = `${trail[index][0]},${trail[index][1]}`;
    if ((levelAt.get(key) || 0) > 0 && !eatenAt.has(key)) {
      eatenAt.set(key, s);
      eaten++;
    }
    headIndex.push(index);
    length.push(initial + eaten);
  }

  const finalLength = length[chainSteps - 1];
  const retractSteps = finalLength - initial;
  for (let r = 1; r <= retractSteps; r++) {
    headIndex.push(trail.length - 1);
    length.push(finalLength - r);
  }
  for (let p = 0; p < PAUSE_STEPS; p++) {
    headIndex.push(trail.length - 1);
    length.push(initial);
  }

  const totalSteps = headIndex.length;
  const states = headIndex.map((head, s) => ({ head, tail: head - length[s] + 1 }));

  const visibility = trail.map((_, j) => {
    let start = -1;
    let end = totalSteps;
    for (let s = 0; s < totalSteps; s++) {
      const visible = states[s].tail <= j && j <= states[s].head;
      if (visible && start === -1) start = s;
      if (!visible && start !== -1) {
        end = s;
        break;
      }
    }
    return { start, end };
  });

  return { trail, levelAt, chainSteps, eatenAt, finalLength, totalSteps, states, visibility };
}

function fmt(value) {
  return Number(value.toFixed(5)).toString();
}

function track(initialValue, changes, total) {
  const times = [0];
  const values = [initialValue];
  for (const [step, value] of changes) {
    if (step <= 0) {
      values[0] = value;
      continue;
    }
    times.push(step / total);
    values.push(value);
  }
  times.push(1);
  values.push(values[values.length - 1]);
  return { keyTimes: times.map(fmt).join(';'), values: values.join(';') };
}

function animate(attribute, initialValue, changes, model) {
  const { keyTimes, values } = track(initialValue, changes, model.totalSteps);
  const dur = fmt(model.totalSteps * STEP_SECONDS);
  return `<animate attributeName="${attribute}" calcMode="discrete" dur="${dur}s" repeatCount="indefinite" keyTimes="${keyTimes}" values="${values}"/>`;
}

function cellX(x) {
  return PAD + x * CELL + (CELL - DOT) / 2;
}

function cellY(y) {
  return PAD + (y + 1) * CELL + (CELL - DOT) / 2;
}

function render(route, model, palette, atStep) {
  const width = PAD * 2 + route.cols * CELL;
  const height = PAD * 2 + (ROWS + 1) * CELL;
  const live = atStep === undefined || atStep === null;
  const state = live ? null : model.states[atStep];
  const empty = palette.dots[0];
  const parts = [];

  for (const cell of route.cells) {
    const color = palette.dots[cell.level];
    const eatenStep = model.eatenAt.get(`${cell.x},${cell.y}`);
    const rect = (fill, inner) =>
      `<rect x="${cellX(cell.x)}" y="${cellY(cell.y)}" width="${DOT}" height="${DOT}" rx="${RADIUS}" fill="${fill}">${inner}</rect>`;
    if (live) {
      const inner = cell.level > 0 && eatenStep !== undefined ? animate('fill', color, [[eatenStep, empty]], model) : '';
      parts.push(rect(color, inner));
    } else {
      const eaten = eatenStep !== undefined && eatenStep <= atStep;
      parts.push(rect(eaten ? empty : color, ''));
    }
  }

  for (let j = 0; j < model.trail.length; j++) {
    const { start, end } = model.visibility[j];
    if (start === -1) continue;
    const base = `x="${cellX(model.trail[j][0])}" y="${cellY(model.trail[j][1])}" width="${DOT}" height="${DOT}" rx="${RADIUS}" fill="${palette.snake}"`;
    if (live) {
      parts.push(`<rect ${base} opacity="0">${animate('opacity', '0', [[start, '1'], [end, '0']], model)}</rect>`);
    } else if (state.tail <= j && j <= state.head) {
      parts.push(`<rect ${base}/>`);
    }
  }

  const headSize = DOT + 2;
  const headShift = (CELL - headSize) / 2;
  const headAt = (point) => `${PAD + point[0] * CELL + headShift} ${PAD + (point[1] + 1) * CELL + headShift}`;
  const headShape = `<rect width="${headSize}" height="${headSize}" rx="${RADIUS + 1}" fill="${palette.head}"/><circle cx="${headSize - 4}" cy="4" r="1.6" fill="${palette.eye}"/><circle cx="${headSize - 4}" cy="${headSize - 4}" r="1.6" fill="${palette.eye}"/>`;
  if (live) {
    const moves = [];
    let previous = headAt(model.trail[model.states[0].head]);
    for (let s = 1; s < model.totalSteps; s++) {
      const here = headAt(model.trail[model.states[s].head]);
      if (here !== previous) {
        moves.push([s, here]);
        previous = here;
      }
    }
    const track1 = track(headAt(model.trail[model.states[0].head]), moves, model.totalSteps);
    const dur = fmt(model.totalSteps * STEP_SECONDS);
    parts.push(
      `<g><animateTransform attributeName="transform" type="translate" calcMode="discrete" dur="${dur}s" repeatCount="indefinite" keyTimes="${track1.keyTimes}" values="${track1.values}"/>${headShape}</g>`,
    );
  } else {
    parts.push(`<g transform="translate(${headAt(model.trail[state.head])})">${headShape}</g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Contribution snake that grows as it eats">
  <title>Contribution snake that grows as it eats</title>
${parts.map((part) => `  ${part}`).join('\n')}
</svg>
`;
}

function main() {
  const route = JSON.parse(fs.readFileSync(ROUTE_FILE, 'utf8'));
  const model = simulate(route);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'snake.svg'), render(route, model, PALETTES.light));
  fs.writeFileSync(path.join(OUT, 'snake-dark.svg'), render(route, model, PALETTES.dark));
  console.log(
    `wrote snake.svg and snake-dark.svg to ${OUT}: ${model.eatenAt.size} squares eaten, final length ${model.finalLength}, loop ${(model.totalSteps * STEP_SECONDS).toFixed(1)}s`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { simulate, render, track, PALETTES, STEP_SECONDS };