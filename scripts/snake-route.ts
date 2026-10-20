// @ts-nocheck
// This file runs inside a checkout of Platane/snk (see snake-grow.yml), where the
// @snk/* packages and ./packages/* paths exist. In this repo the editor cannot
// resolve them, so type checking is switched off for this one file.
import { readFileSync, writeFileSync } from "node:fs";
import { getGithubUserContribution } from "@snk/github-user-contribution";
import { getBestRoute } from "@snk/solver/getBestRoute";
import { getPathToPose } from "@snk/solver/getPathToPose";
import { snake4 } from "@snk/types/__fixtures__/snake";
import { snakeToCells } from "@snk/types/snake";
import { cellsToGrid } from "./packages/generate-snake-animation/cellsToGrid";

const user = process.env.SNAKE_USER ?? "switch-afk";
const out = process.env.ROUTE_OUT ?? "route.json";
const file = process.env.CONTRIBUTIONS_FILE;

async function main() {
  const cells = file
    ? JSON.parse(readFileSync(file, "utf8"))
    : await getGithubUserContribution(user, {
        githubToken: process.env.GITHUB_TOKEN ?? "",
      });

  const grid = cellsToGrid(cells);
  const chain = getBestRoute(grid, snake4);
  if (!chain) throw new Error("no route found for the contribution grid");
  const home = getPathToPose(chain[chain.length - 1], snake4);
  if (!home) throw new Error("no way back to the starting pose");
  chain.push(...home);

  // tail to head, as the snake sits at the start
  const initial = snakeToCells(chain[0]).reverse();
  const trail = [
    ...initial.map((p) => [p.x, p.y]),
    ...chain.slice(1).map((snake) => {
      const [head] = snakeToCells(snake);
      return [head.x, head.y];
    }),
  ];

  writeFileSync(
    out,
    JSON.stringify({
      cols: Math.max(...cells.map((c) => c.x)) + 1,
      initialLength: initial.length,
      cells: cells.map(({ x, y, level }) => ({ x, y, level })),
      trail,
    }),
  );
  console.log(
    `route: ${chain.length} steps, ${cells.filter((c) => c.level > 0).length} active days, written to ${out}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});