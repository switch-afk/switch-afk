'use strict';

const fs = require('node:fs');
const path = require('node:path');

const USER = process.env.SNAKE_USER || 'switch-afk';
const OUT = process.env.SNAKE_OUT || 'dist-snake';
const TOKEN = process.env.GITHUB_TOKEN || '';
const CONTRIBUTIONS_FILE = process.env.CONTRIBUTIONS_FILE || '';

const CELL = 16;
const DOT = 12;
const RADIUS = 3;
const PAD = 8;
const ROWS = 7;
const MARGIN = 2;
const START_LENGTH = 4;
const STEP_SECONDS = 0.1;
const PAUSE_STEPS = 25;
const MAX_STEPS = 4000;

const PALETTES = {
  light: {
    dots: ['#ebedf0', '#e4d4ff', '#c9a8ff', '#9945ff', '#6a1fd6'],
    snake: '#14b87a',
    head: '#0b8f5d',
    eye: '#ffffff',
  },
  dark: {
    dots: ['#161b22', '#3b2a6e', '#6c3fc4', '#9945ff', '#c7a2ff'],
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

async function fetchCells(user) {
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
  const cells = [];
  weeks.forEach((week, x) => {
    for (const day of week.contributionDays) {
      const known = LEVELS[day.contributionLevel];
      const level = known !== undefined ? known : day.contributionCount > 0 ? 1 : 0;
      cells.push({ x, y: day.weekday, level });
    }
  });
  return cells;
}

// ---------------------------------------------------------------------------
// route planning: the snake grows by one each time it eats, and never crosses itself

function createWorld(cols) {
  const minX = -MARGIN;
  const maxX = cols - 1 + MARGIN;
  const minY = -MARGIN;
  const maxY = ROWS - 1 + MARGIN;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  return {
    cols,
    minX,
    minY,
    width,
    height,
    size: width * height,
    id: (x, y) => (y - minY) * width + (x - minX),
    x: (id) => (id % width) + minX,
    y: (id) => Math.floor(id / width) + minY,
    neighbors(id) {
      const out = [];
      const cx = id % width;
      const cy = Math.floor(id / width);
      if (cy > 0) out.push(id - width);
      if (cx < width - 1) out.push(id + 1);
      if (cy < height - 1) out.push(id + width);
      if (cx > 0) out.push(id - 1);
      return out;
    },
  };
}

// breadth-first search that knows the tail moves away as the head moves forward
function search(world, body, isGoal, blocked) {
  const length = body.length;
  const occupant = new Int32Array(world.size).fill(-1);
  body.forEach((cell, i) => {
    occupant[cell] = i;
  });
  const dist = new Int32Array(world.size).fill(-1);
  const parent = new Int32Array(world.size).fill(-1);
  const queue = [body[0]];
  dist[body[0]] = 0;
  const goals = [];
  for (let q = 0; q < queue.length; q++) {
    const cell = queue[q];
    const d = dist[cell];
    if (d > 0 && isGoal(cell)) goals.push(cell);
    for (const next of world.neighbors(cell)) {
      if (dist[next] !== -1) continue;
      if (blocked && blocked.has(next)) continue;
      if (occupant[next] !== -1 && d + 1 < length - occupant[next]) continue;
      dist[next] = d + 1;
      parent[next] = cell;
      queue.push(next);
    }
  }
  return { goals, parent };
}

function pathTo(parent, start, goal) {
  const cells = [];
  for (let cell = goal; cell !== start; cell = parent[cell]) cells.push(cell);
  return cells.reverse();
}

// walk a path, growing on uneaten squares; null if the snake would hit itself
function walk(body, path, uneaten) {
  const next = body.slice();
  const eaten = [];
  for (const cell of path) {
    const grows = uneaten.has(cell) && !eaten.includes(cell);
    const at = next.indexOf(cell);
    if (at !== -1 && !(at === next.length - 1 && !grows)) return null;
    next.unshift(cell);
    if (grows) eaten.push(cell);
    else next.pop();
  }
  return { body: next, eaten };
}

// the snake can still reach its own tail, so it can never trap itself
function canReachTail(world, body) {
  const tail = body[body.length - 1];
  const blocked = new Uint8Array(world.size);
  for (let i = 0; i < body.length - 1; i++) blocked[body[i]] = 1;
  const seen = new Uint8Array(world.size);
  const stack = [body[0]];
  seen[body[0]] = 1;
  while (stack.length > 0) {
    const cell = stack.pop();
    if (cell === tail) return true;
    for (const next of world.neighbors(cell)) {
      if (seen[next] || blocked[next]) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
  return false;
}

function startBody(world) {
  const body = [];
  for (let i = 0; i < START_LENGTH; i++) body.push(world.id(i, -1)); // head first
  return body;
}

// eat the nearest square that keeps the snake able to reach its own tail
function routeNearest(world, uneatenInput) {
  const uneaten = new Set(uneatenInput);
  let body = startBody(world);
  const moves = [];
  let seed = 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const apply = (path) => {
    const result = walk(body, path, uneaten);
    for (const cell of path) {
      const grew = uneaten.has(cell);
      moves.push({ cell, grew });
      if (grew) uneaten.delete(cell);
    }
    body = result.body;
  };

  let idle = 0;
  while (uneaten.size > 0) {
    if (moves.length > MAX_STEPS) throw new Error('route planning ran too long');
    const { goals, parent } = search(world, body, (cell) => uneaten.has(cell));
    let chosen = null;
    for (const goal of goals) {
      const path = pathTo(parent, body[0], goal);
      const result = walk(body, path, uneaten);
      if (result && canReachTail(world, result.body)) {
        chosen = path;
        break;
      }
    }
    if (chosen) {
      apply(chosen);
      idle = 0;
      continue;
    }
    // no safe target right now: shuffle around safely until space opens up
    const options = world.neighbors(body[0]).filter((cell) => {
      const result = walk(body, [cell], uneaten);
      return result && canReachTail(world, result.body);
    });
    if (options.length > 0 && idle >= 20) {
      apply([options[Math.floor(random() * options.length)]]);
    } else {
      const tail = body[body.length - 1];
      const toTail = search(world, body, (cell) => cell === tail);
      if (toTail.goals.length === 0) throw new Error('snake is trapped');
      apply(pathTo(toTail.parent, body[0], toTail.goals[0]).slice(0, 1));
    }
    if (++idle > 600) throw new Error('snake keeps circling without eating');
  }
  return moves;
}

// guaranteed fallback: sweep column by column, which can never cross itself
function routeSweep(world, uneatenInput) {
  const uneaten = new Set(uneatenInput);
  const moves = [];
  const visit = (x, y) => {
    const cell = world.id(x, y);
    const grew = uneaten.has(cell);
    moves.push({ cell, grew });
    if (grew) uneaten.delete(cell);
  };
  for (let x = 0; x < world.cols; x++) {
    for (let i = 0; i < ROWS; i++) visit(x, x % 2 === 0 ? i : ROWS - 1 - i);
  }
  return moves;
}

function plan(cells, cols) {
  const world = createWorld(cols);
  const uneaten = new Set(cells.filter((cell) => cell.level > 0).map((cell) => world.id(cell.x, cell.y)));

  let moves;
  let strategy = 'nearest';
  try {
    moves = routeNearest(world, uneaten);
  } catch (error) {
    strategy = 'sweep';
    moves = routeSweep(world, uneaten);
  }

  // rebuild the body by replaying the moves
  let body = startBody(world);
  const trail = body.slice().reverse(); // tail to head
  const eatenAt = new Map();
  moves.forEach((move, k) => {
    trail.push(move.cell);
    body.unshift(move.cell);
    if (move.grew) eatenAt.set(move.cell, k + 1);
    else body.pop();
  });
  const finalLength = body.length;

  // timeline: eat, curl back to the start size, walk home, rest
  const states = [];
  let length = START_LENGTH;
  states.push({ head: START_LENGTH - 1, length });
  moves.forEach((move, k) => {
    if (move.grew) length++;
    states.push({ head: START_LENGTH + k, length });
  });
  const lastHead = trail.length - 1;
  for (let l = finalLength - 1; l >= START_LENGTH; l--) states.push({ head: lastHead, length: l });

  // after curling up the body is the last START_LENGTH cells; return to the exact start pose
  body = trail.slice(-START_LENGTH).reverse();
  const doorway = world.id(START_LENGTH - 1, -1);
  const lane = [];
  for (let x = START_LENGTH - 2; x >= 0; x--) lane.push(world.id(x, -1));
  const toDoor = search(world, body, (cell) => cell === doorway, new Set(lane));
  let home = null;
  if (body[0] === doorway) home = lane;
  else if (toDoor.goals.length > 0) home = [...pathTo(toDoor.parent, body[0], doorway), ...lane];
  if (!home || !walk(body, home, new Set())) {
    const target = world.id(0, -1);
    const direct = search(world, body, (cell) => cell === target);
    home = direct.goals.length > 0 ? pathTo(direct.parent, body[0], target) : [];
  }
  for (const cell of home) {
    trail.push(cell);
    states.push({ head: trail.length - 1, length: START_LENGTH });
  }
  for (let p = 0; p < PAUSE_STEPS; p++) states.push({ head: trail.length - 1, length: START_LENGTH });

  const stepsTotal = states.length;
  const marked = states.map((state) => ({ head: state.head, tail: state.head - state.length + 1 }));
  const visibility = trail.map((_, j) => {
    let start = -1;
    let end = stepsTotal;
    for (let s = 0; s < stepsTotal; s++) {
      const visible = marked[s].tail <= j && j <= marked[s].head;
      if (visible && start === -1) start = s;
      if (!visible && start !== -1) {
        end = s;
        break;
      }
    }
    return { start, end };
  });

  const eatenStep = new Map();
  for (const [cell, step] of eatenAt) eatenStep.set(`${world.x(cell)},${world.y(cell)}`, step);

  return {
    world,
    strategy,
    trail: trail.map((cell) => [world.x(cell), world.y(cell)]),
    states: marked,
    visibility,
    eatenStep,
    finalLength,
    totalSteps: stepsTotal,
    cols,
    cells,
  };
}

// ---------------------------------------------------------------------------
// drawing

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
  return PAD + (x + MARGIN) * CELL + (CELL - DOT) / 2;
}

function cellY(y) {
  return PAD + (y + MARGIN) * CELL + (CELL - DOT) / 2;
}

function render(model, palette, atStep) {
  const width = PAD * 2 + (model.cols + MARGIN * 2) * CELL;
  const height = PAD * 2 + (ROWS + MARGIN * 2) * CELL;
  const live = atStep === undefined || atStep === null;
  const state = live ? null : model.states[atStep];
  const empty = palette.dots[0];
  const parts = [];

  for (const cell of model.cells) {
    const color = palette.dots[cell.level];
    const eatenStep = model.eatenStep.get(`${cell.x},${cell.y}`);
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
  const headAt = (point) => `${PAD + (point[0] + MARGIN) * CELL + headShift} ${PAD + (point[1] + MARGIN) * CELL + headShift}`;
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
    const motion = track(headAt(model.trail[model.states[0].head]), moves, model.totalSteps);
    const dur = fmt(model.totalSteps * STEP_SECONDS);
    parts.push(
      `<g><animateTransform attributeName="transform" type="translate" calcMode="discrete" dur="${dur}s" repeatCount="indefinite" keyTimes="${motion.keyTimes}" values="${motion.values}"/>${headShape}</g>`,
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

async function main() {
  let cells;
  if (CONTRIBUTIONS_FILE) {
    cells = JSON.parse(fs.readFileSync(CONTRIBUTIONS_FILE, 'utf8'));
  } else {
    if (!TOKEN) throw new Error('GITHUB_TOKEN is required');
    cells = await fetchCells(USER);
  }
  const cols = Math.max(...cells.map((cell) => cell.x)) + 1;
  const model = plan(cells, cols);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'snake.svg'), render(model, PALETTES.light));
  fs.writeFileSync(path.join(OUT, 'snake-dark.svg'), render(model, PALETTES.dark));
  console.log(
    `wrote snake.svg and snake-dark.svg to ${OUT}: ${model.eatenStep.size} squares eaten, final length ${model.finalLength}, loop ${(model.totalSteps * STEP_SECONDS).toFixed(1)}s`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { plan, routeNearest, routeSweep, render, createWorld, PALETTES, STEP_SECONDS, ROWS, MARGIN, START_LENGTH };