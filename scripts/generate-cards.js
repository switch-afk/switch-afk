'use strict';

const fs = require('node:fs');
const path = require('node:path');

const USER = process.env.CARDS_USER || 'switch-afk';
const OUT = process.env.CARDS_OUT || 'dist';
const TOKEN = process.env.GITHUB_TOKEN || '';

const THEME = {
  bg: '#1a1b27',
  border: '#2f3146',
  title: '#70a5fd',
  text: '#38bdae',
  muted: '#7f8aa3',
  icon: '#bf91f3',
  accent: '#14f195',
};

const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif";

const LANGUAGE_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  EJS: '#a91e50',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Python: '#3572a5',
  Shell: '#89e051',
  Rust: '#dea584',
  Dart: '#00b4ab',
  Kotlin: '#a97bff',
  Java: '#b07219',
  Go: '#00add8',
  SCSS: '#c6538c',
  PowerShell: '#012456',
};
const FALLBACK_COLORS = ['#9945ff', '#14f195', '#70a5fd', '#bf91f3', '#38bdae', '#f7768e'];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function api(pathname) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'profile-cards',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${pathname}`);
  }
  return response.json();
}

async function fetchRepos(user) {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/users/${user}/repos?per_page=100&type=owner&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

async function fetchLanguageBytes(user, repos) {
  const totals = {};
  for (const repo of repos) {
    try {
      const languages = await api(`/repos/${user}/${repo.name}/languages`);
      for (const [name, bytes] of Object.entries(languages)) {
        totals[name] = (totals[name] || 0) + bytes;
      }
    } catch (error) {
      console.warn(`skipping languages for ${repo.name}: ${error.message}`);
    }
  }
  return totals;
}

function summarize(profile, repos) {
  const own = repos.filter((repo) => !repo.fork);
  return {
    stars: own.reduce((sum, repo) => sum + repo.stargazers_count, 0),
    forks: own.reduce((sum, repo) => sum + repo.forks_count, 0),
    repos: profile.public_repos,
    followers: profile.followers,
  };
}

function topLanguages(totals, limit) {
  const all = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const sum = all.reduce((acc, [, bytes]) => acc + bytes, 0);
  if (sum === 0) return [];
  return all.slice(0, limit).map(([name, bytes], index) => ({
    name,
    percent: (bytes / sum) * 100,
    color: LANGUAGE_COLORS[name] || FALLBACK_COLORS[index % FALLBACK_COLORS.length],
  }));
}

async function fetchRecentWork(user, repos, limit) {
  const candidates = repos
    .filter((repo) => !repo.fork && !repo.archived && repo.name.toLowerCase() !== user.toLowerCase())
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, limit + 3);
  const work = [];
  for (const repo of candidates) {
    try {
      const commits = await api(`/repos/${user}/${repo.name}/commits?per_page=5`);
      const list = commits
        .map((item) => ({
          message: String(item.commit.message).split('\n')[0].trim(),
          date: new Date(item.commit.author.date),
        }))
        .filter((commit) => commit.message.length > 0);
      if (list.length === 0) continue;
      work.push({ name: repo.name, description: repo.description || '', commits: list });
    } catch (error) {
      console.warn(`skipping commits for ${repo.name}: ${error.message}`);
    }
  }
  return work.sort((a, b) => b.commits[0].date - a.commits[0].date).slice(0, limit);
}

function timeAgo(date, now) {
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function truncate(text, max) {
  const clean = String(text);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}\u2026`;
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

function formatDate(date) {
  return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function frame(width, height, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <title>${escapeXml(title)}</title>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="4.5" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text x="25" y="35" font-family="${FONT}" font-size="18" font-weight="600" fill="${THEME.title}">${escapeXml(title)}</text>
${body}
</svg>
`;
}

function renderStats(user, stats, updated) {
  const rows = [
    ['Total Stars Earned', stats.stars],
    ['Total Forks', stats.forks],
    ['Public Repos', stats.repos],
    ['Followers', stats.followers],
  ];
  const lines = rows
    .map(([label, value], index) => {
      const y = 70 + index * 25;
      return `  <circle cx="32" cy="${y - 5}" r="4" fill="${THEME.icon}"/>
  <text x="46" y="${y}" font-family="${FONT}" font-size="14" font-weight="600" fill="${THEME.text}">${escapeXml(label)}:</text>
  <text x="300" y="${y}" font-family="${FONT}" font-size="14" font-weight="700" fill="${THEME.text}">${escapeXml(formatNumber(value))}</text>`;
    })
    .join('\n');
  const footer = `  <text x="25" y="176" font-family="${FONT}" font-size="10" fill="${THEME.muted}">Updated ${escapeXml(formatDate(updated))}</text>`;
  return frame(380, 190, `${user}'s GitHub Stats`, `${lines}\n${footer}`);
}

function renderLanguages(languages, updated) {
  const barX = 25;
  const barWidth = 250;
  let offset = 0;
  const segments = languages
    .map((language) => {
      const width = (language.percent / 100) * barWidth;
      const rect = `<rect x="${(barX + offset).toFixed(2)}" y="50" width="${width.toFixed(2)}" height="8" fill="${language.color}"/>`;
      offset += width;
      return rect;
    })
    .join('\n    ');
  const bar = `  <clipPath id="bar"><rect x="${barX}" y="50" width="${barWidth}" height="8" rx="4"/></clipPath>
  <g clip-path="url(#bar)">
    ${segments}
  </g>`;
  const list = languages
    .map((language, index) => {
      const y = 82 + index * 14;
      return `  <circle cx="30" cy="${y - 4}" r="4" fill="${language.color}"/>
  <text x="42" y="${y}" font-family="${FONT}" font-size="11" fill="${THEME.text}">${escapeXml(language.name)} ${language.percent.toFixed(1)}%</text>`;
    })
    .join('\n');
  const footer = `  <text x="25" y="176" font-family="${FONT}" font-size="10" fill="${THEME.muted}">Updated ${escapeXml(formatDate(updated))}</text>`;
  return frame(300, 190, 'Top Languages', `${bar}\n${list}\n${footer}`);
}

function renderBuilding(work, updated) {
  const width = 820;
  if (work.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="90" viewBox="0 0 ${width} 90" role="img" aria-label="Currently building">
  <rect x="0.5" y="0.5" width="${width - 1}" height="89" rx="4.5" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text x="25" y="50" font-family="${FONT}" font-size="14" fill="${THEME.muted}">No recent public commits yet.</text>
</svg>
`;
  }

  const [main, ...others] = work;
  const parts = [];
  const fresh = updated - main.commits[0].date < 3 * 24 * 3600 * 1000;
  const label = fresh ? 'NOW' : 'LATEST';
  const pillWidth = label.length * 8 + 16;

  parts.push(`  <rect x="25" y="18" width="${pillWidth}" height="20" rx="10" fill="${THEME.accent}"/>`);
  parts.push(`  <text x="${25 + pillWidth / 2}" y="32" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="700" fill="${THEME.bg}">${label}</text>`);
  parts.push(`  <text x="${25 + pillWidth + 12}" y="34" font-family="${FONT}" font-size="20" font-weight="600" fill="${THEME.title}">${escapeXml(main.name)}</text>`);
  parts.push(`  <text x="${width - 25}" y="34" text-anchor="end" font-family="${FONT}" font-size="12" fill="${THEME.muted}">last commit ${escapeXml(timeAgo(main.commits[0].date, updated))}</text>`);
  if (main.description) {
    parts.push(`  <text x="25" y="60" font-family="${FONT}" font-size="13" fill="${THEME.muted}">${escapeXml(truncate(main.description, 110))}</text>`);
  }

  let y = main.description ? 90 : 72;
  for (const commit of main.commits.slice(0, 3)) {
    parts.push(`  <text x="25" y="${y}" font-family="${FONT}" font-size="13" font-weight="700" fill="${THEME.icon}">&#8250;</text>`);
    parts.push(`  <text x="42" y="${y}" font-family="${FONT}" font-size="13" fill="${THEME.text}">${escapeXml(truncate(commit.message, 88))}</text>`);
    parts.push(`  <text x="${width - 25}" y="${y}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${THEME.muted}">${escapeXml(timeAgo(commit.date, updated))}</text>`);
    y += 22;
  }

  if (others.length > 0) {
    y += 2;
    parts.push(`  <line x1="25" y1="${y}" x2="${width - 25}" y2="${y}" stroke="${THEME.border}"/>`);
    parts.push(`  <text x="25" y="${y + 24}" font-family="${FONT}" font-size="11" font-weight="600" fill="${THEME.muted}">ALSO MOVING</text>`);
    y += 24;
    for (const repo of others) {
      y += 26;
      parts.push(`  <circle cx="30" cy="${y - 4}" r="3.5" fill="${THEME.icon}"/>`);
      parts.push(`  <text x="42" y="${y}" font-family="${FONT}" font-size="13" font-weight="600" fill="${THEME.title}">${escapeXml(truncate(repo.name, 22))}</text>`);
      parts.push(`  <text x="256" y="${y}" font-family="${FONT}" font-size="13" fill="${THEME.text}">${escapeXml(truncate(repo.commits[0].message, 62))}</text>`);
      parts.push(`  <text x="${width - 25}" y="${y}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${THEME.muted}">${escapeXml(timeAgo(repo.commits[0].date, updated))}</text>`);
    }
  }

  const footerY = y + 32;
  parts.push(`  <text x="25" y="${footerY}" font-family="${FONT}" font-size="10" fill="${THEME.muted}">Auto-updated from my latest public commits. Updated ${escapeXml(formatDate(updated))}</text>`);
  const height = footerY + 16;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Currently building: ${escapeXml(main.name)}">
  <title>Currently building: ${escapeXml(main.name)}</title>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="4.5" fill="${THEME.bg}" stroke="${THEME.border}"/>
${parts.join('\n')}
</svg>
`;
}

async function main() {
  const profile = await api(`/users/${USER}`);
  const repos = await fetchRepos(USER);
  const own = repos.filter((repo) => !repo.fork);
  const totals = await fetchLanguageBytes(USER, own);
  const updated = new Date();

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'stats.svg'), renderStats(USER, summarize(profile, repos), updated));
  fs.writeFileSync(path.join(OUT, 'top-langs.svg'), renderLanguages(topLanguages(totals, 6), updated));
  const work = await fetchRecentWork(USER, repos, 5);
  fs.writeFileSync(path.join(OUT, 'building.svg'), renderBuilding(work, updated));
  console.log(`wrote stats.svg, top-langs.svg and building.svg to ${OUT} for ${USER}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { main, summarize, topLanguages, renderStats, renderLanguages, renderBuilding, fetchRecentWork, timeAgo, truncate, escapeXml };