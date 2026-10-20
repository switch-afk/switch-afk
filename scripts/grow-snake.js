'use strict';

const fs = require('node:fs');
const path = require('node:path');

const USER = process.env.SNAKE_USER || 'switch-afk';
const OUT = process.env.SNAKE_OUT || 'dist-snake';
const TOKEN = process.env.GITHUB_TOKEN || '';

const CELL = 16;
const DOT = 12;
const RADIUS = 3;
const PAD = 8;
const STEP_SECONDS = 0.12;
const PAUSE_STEPS = 25;
const ROWS = 7;

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

const LEVELS = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

async function fetchCalendar(user) {
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks { contributionDays { weekday contributionCount contributionLevel } }
        }
      }
    }
  }`;
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'grow-snake',
    },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}`);
  const body = await response.json();
  if (body.errors) throw new Error(`GitHub GraphQL error: ${body.errors[0].message}`);
  const weeks = body.data && body.data.user && body.data.user.contributionsCollection.contributionCalendar.weeks;
  if (!weeks || weeks.length === 0) throw new Error('no contribution calendar returned');
  return weeks;
}

function buildGrid(weeks) {
  const cols = weeks.length;
  const cells = [];
  for (let x = 0; x < cols; x++) {
    for (const day of weeks[x].contributionDays) {
      const known = LEVELS[day.contributionLevel];
      const level = known !== undefined ? known : day.contributionCount > 0 ? 1 : 0;
      cells.push({ x, y: day.weekday, level });
    }
  }
  return { cols, cells };
}

function buildPath(cols) {
  const route = [];
  for (let x = 0; x < cols; x++) {
    for (let i = 0; i < ROWS; i++) {
      route.push({ x, y: x % 2 === 0 ? i : ROWS - 1 - i });
    }
  }
  return route;
}

function simulate(grid) {
  const route = buildPath(grid.cols);
  const levelAt = new Map(grid.cells.map((cell) => [`${cell.x},${cell.y}`, cell.level]));
  const n = route.length;

  const lengthAtHead = [];
  let eaten = 0;
  for (let k = 0; k < n; k++) {
    if ((levelAt.get(`${route[k].x},${route[k].y}`) || 0) > 0) eaten++;
    lengthAtHead.push(1 + eaten);
  }
  const finalLength = lengthAtHead[n - 1];
  const totalSteps = n + finalLength + PAUSE_STEPS;

  const states = [];
  for (let s = 0; s < totalSteps; s++) {
    if (s < n) {
      states.push({ head: s, tail: s - lengthAtHead[s] + 1 });
    } else {
      const length = finalLength - (s - (n - 1));
      states.push(length >= 1 ? { head: n - 1, tail: n - length } : null);
    }
  }

  const visibility = route.map((_, k) => {
    let start = -1;
    let end = totalSteps;
    for (let s = 0; s < totalSteps; s++) {
      const st = states[s];
      const visible = st !== null && st.tail <= k && k <= st.head;
      if (visible && start === -1) start = s;
      if (!visible && start !== -1) {
        end = s;
        break;
      }
    }
    return { start, end };
  });

  return { route, levelAt, n, finalLength, totalSteps, states, visibility };
}

function fmt(value) {
  return Number(value.toFixed(5)).toString();
}

function track(initial, changes, total) {
  const times = [0];
  const values = [initial];
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

function animate(attribute, initial, changes, model) {
  const { keyTimes, values } = track(initial, changes, model.totalSteps);
  const dur = fmt(model.totalSteps * STEP_SECONDS);
  return `<animate attributeName="${attribute}" calcMode="discrete" dur="${dur}s" repeatCount="indefinite" keyTimes="${keyTimes}" values="${values}"/>`;
}

function cellX(x) {
  return PAD + x * CELL + (CELL - DOT) / 2;
}

function cellY(y) {
  return PAD + y * CELL + (CELL - DOT) / 2;
}

function render(grid, model, palette, atStep) {
  const width = PAD * 2 + grid.cols * CELL;
  const height = PAD * 2 + ROWS * CELL;
  const live = atStep === undefined || atStep === null;
  const state = live ? null : model.states[atStep];
  const empty = palette.dots[0];
  const parts = [];

  for (const cell of grid.cells) {
    const k = model.route.findIndex((p) => p.x === cell.x && p.y === cell.y);
    const color = palette.dots[cell.level];
    const rect = (fill, inner) =>
      `<rect x="${cellX(cell.x)}" y="${cellY(cell.y)}" width="${DOT}" height="${DOT}" rx="${RADIUS}" fill="${fill}">${inner}</rect>`;
    if (live) {
      const inner = cell.level > 0 ? animate('fill', color, [[k, empty]], model) : '';
      parts.push(rect(color, inner));
    } else {
      const eaten = state ? k <= state.head : atStep >= model.n;
      parts.push(rect(cell.level > 0 && eaten ? empty : color, ''));
    }
  }

  for (let k = 0; k < model.n; k++) {
    const p = model.route[k];
    const { start, end } = model.visibility[k];
    if (start === -1) continue;
    const base = `x="${cellX(p.x)}" y="${cellY(p.y)}" width="${DOT}" height="${DOT}" rx="${RADIUS}" fill="${palette.snake}"`;
    if (live) {
      parts.push(`<rect ${base} opacity="0">${animate('opacity', '0', [[start, '1'], [end, '0']], model)}</rect>`);
    } else if (state && state.tail <= k && k <= state.head) {
      parts.push(`<rect ${base}/>`);
    }
  }

  const headSize = DOT + 2;
  const headShift = (CELL - headSize) / 2;
  const headAt = (p) => `${PAD + p.x * CELL + headShift} ${PAD + p.y * CELL + headShift}`;
  const headShape = `<rect width="${headSize}" height="${headSize}" rx="${RADIUS + 1}" fill="${palette.head}"/><circle cx="${headSize - 4}" cy="4" r="1.6" fill="${palette.eye}"/><circle cx="${headSize - 4}" cy="${headSize - 4}" r="1.6" fill="${palette.eye}"/>`;
  if (live) {
    const sweep = model.route.map((p, s) => [s, headAt(p)]);
    const moves = track(headAt(model.route[0]), sweep.slice(1), model.totalSteps);
    const dur = fmt(model.totalSteps * STEP_SECONDS);
    const lastVisible = model.states.findIndex((s, i) => s === null && i > 0);
    parts.push(
      `<g opacity="1"><animate attributeName="opacity" calcMode="discrete" dur="${dur}s" repeatCount="indefinite" ${(() => {
        const t = track('1', [[lastVisible === -1 ? model.totalSteps : lastVisible, '0']], model.totalSteps);
        return `keyTimes="${t.keyTimes}" values="${t.values}"`;
      })()}/><g><animateTransform attributeName="transform" type="translate" calcMode="discrete" dur="${dur}s" repeatCount="indefinite" keyTimes="${moves.keyTimes}" values="${moves.values}"/>${headShape}</g></g>`,
    );
  } else if (state) {
    parts.push(`<g transform="translate(${headAt(model.route[state.head])})">${headShape}</g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Contribution snake that grows as it eats">
  <title>Contribution snake that grows as it eats</title>
${parts.map((part) => `  ${part}`).join('\n')}
</svg>
`;
}

async function main() {
  if (!TOKEN) throw new Error('GITHUB_TOKEN is required');
  const weeks = await fetchCalendar(USER);
  const grid = buildGrid(weeks);
  const model = simulate(grid);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'snake.svg'), render(grid, model, PALETTES.light));
  fs.writeFileSync(path.join(OUT, 'snake-dark.svg'), render(grid, model, PALETTES.dark));
  const activeDays = grid.cells.filter((cell) => cell.level > 0).length;
  console.log(
    `wrote snake.svg and snake-dark.svg to ${OUT}: ${grid.cols} weeks, ${activeDays} active days, final length ${model.finalLength}, loop ${(model.totalSteps * STEP_SECONDS).toFixed(1)}s`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { buildGrid, buildPath, simulate, render, track, PALETTES, STEP_SECONDS };