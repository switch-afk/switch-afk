'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Two eyes drawn on the head. They reuse the head's class (s s0), so they pick up the
// head's animation and move with it. Positions are inside the head's 16px cell.
const EYES = [
  '<circle class="s s0 eye" cx="5.2" cy="5.6" r="2" style="fill:#fff"/>',
  '<circle class="s s0 eye" cx="10.8" cy="5.6" r="2" style="fill:#fff"/>',
  '<circle class="s s0 eye" cx="5.2" cy="5.6" r="0.9" style="fill:#0d1117"/>',
  '<circle class="s s0 eye" cx="10.8" cy="5.6" r="0.9" style="fill:#0d1117"/>',
].join('');

const dir = process.argv[2] || 'dist';

for (const name of ['snake.svg', 'snake-dark.svg']) {
  const file = path.join(dir, name);
  const svg = fs.readFileSync(file, 'utf8');
  if (svg.includes('class="s s0 eye"')) continue;
  if (!svg.includes('class="s s0"')) throw new Error(`${name}: no snake head found`);
  const end = svg.lastIndexOf('</svg>');
  if (end === -1) throw new Error(`${name}: no closing svg tag`);
  fs.writeFileSync(file, svg.slice(0, end) + EYES + svg.slice(end));
  console.log(`added eyes to ${file}`);
}