import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUTS = ['assets/contributions.json', 'assets/contributions.svg', 'assets/contributions-mobile.svg'];
const GRAPHQL_URL = 'https://api.github.com/graphql';

export function utcDateWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364);
  const date = (value) => value.toISOString().slice(0, 10);
  return { from: date(start), to: date(end) };
}

function dateRange(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

const QUERY = `query Contributions($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

async function fetchAccount(account, token, window, fetchImpl = fetch) {
  const from = `${window.from}T00:00:00Z`;
  const to = `${window.to}T23:59:59Z`;
  let response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        'user-agent': 'combined-profile-contributions'
      },
      body: JSON.stringify({ query: QUERY, variables: { from, to } }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new Error(`Could not fetch contributions for ${account.login}.`);
  }
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${account.login}.`);
  const scopes = response.headers?.get?.('x-oauth-scopes');
  if (scopes !== null && scopes !== undefined && !scopes.split(',').map((s) => s.trim()).includes('read:user')) {
    throw new Error(`Token for ${account.login} does not include the read:user scope.`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`GitHub returned an unreadable response for ${account.login}.`);
  }
  if (!payload || (Array.isArray(payload.errors) && payload.errors.length)) {
    throw new Error(`GitHub GraphQL failed for ${account.login}.`);
  }
  const viewer = payload.data?.viewer;
  if (!viewer || typeof viewer.login !== 'string' || viewer.login.toLowerCase() !== account.login.toLowerCase()) {
    throw new Error(`Token identity did not match configured account ${account.login}.`);
  }
  const calendar = viewer.contributionsCollection?.contributionCalendar;
  if (!calendar || !Array.isArray(calendar.weeks) || !Number.isSafeInteger(calendar.totalContributions) || calendar.totalContributions < 0) {
    throw new Error(`Contribution data was incomplete for ${account.login}.`);
  }
  const byDate = new Map();
  for (const week of calendar.weeks) {
    if (!Array.isArray(week?.contributionDays)) throw new Error(`Contribution dates were incomplete for ${account.login}.`);
    for (const day of week.contributionDays) {
      if (typeof day?.date !== 'string' || !Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0 || byDate.has(day.date)) {
        throw new Error(`Contribution dates or counts were invalid for ${account.login}.`);
      }
      byDate.set(day.date, day.contributionCount);
    }
  }
  const expected = dateRange(window.from, window.to);
  if (byDate.size !== expected.length || expected.some((date) => !byDate.has(date))) {
    throw new Error(`Contribution dates did not cover the requested range for ${account.login}.`);
  }
  const sum = [...byDate.values()].reduce((total, count) => total + count, 0);
  if (sum !== calendar.totalContributions) throw new Error(`Contribution totals did not match daily counts for ${account.login}.`);
  return { login: account.login, dailyCounts: byDate };
}

export function aggregateAccounts(results, window, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(results) || results.length < 1) throw new Error('At least one configured account is required.');
  const dates = dateRange(window.from, window.to);
  const dayCounts = new Map(dates.map((date) => [date, 0]));
  const accounts = results.map(({ login, dailyCounts }) => {
    if (!login || !(dailyCounts instanceof Map) || dailyCounts.size !== dates.length || dates.some((date) => !dailyCounts.has(date))) {
      throw new Error('An account has incomplete daily contribution data.');
    }
    let totalContributions = 0;
    for (const date of dates) {
      const count = dailyCounts.get(date);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Daily contribution counts must be non-negative integers.');
      totalContributions += count;
      dayCounts.set(date, dayCounts.get(date) + count);
    }
    return { login, totalContributions };
  });
  const days = dates.map((date) => ({ date, count: dayCounts.get(date) }));
  const totalContributions = days.reduce((sum, day) => sum + day.count, 0);
  return {
    schemaVersion: 1,
    generatedAt,
    from: window.from,
    to: window.to,
    accounts,
    totalContributions,
    activeDays: days.filter((day) => day.count > 0).length,
    days
  };
}

const COLORS = { bg: '#091F2C', fg: '#EFFEEB', secondary: '#91FEE6', empty: '#102c37', ramp: ['#123a43', '#0E534C', '#029F8C', '#07DFC1'] };
const esc = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const monthLabel = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
const displayDate = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function level(count, thresholds) {
  if (!count) return 0;
  return count <= thresholds[0] ? 1 : count <= thresholds[1] ? 2 : count <= thresholds[2] ? 3 : 4;
}

function svgHeatmap(data, mobile = false) {
  const daySize = mobile ? 9 : 11;
  const gap = mobile ? 3 : 3;
  const step = daySize + gap;
  const labelWidth = mobile ? 27 : 34;
  const top = 110;
  const bandGap = mobile ? 20 : 0;
  const start = new Date(`${data.from}T00:00:00Z`);
  const leading = start.getUTCDay();
  const bands = mobile ? [data.days.slice(0, Math.ceil(data.days.length / 2)), data.days.slice(Math.ceil(data.days.length / 2))] : [data.days];
  const positives = data.days.map((day) => day.count).filter((count) => count > 0).sort((a, b) => a - b);
  const quantile = (fraction) => positives.length ? positives[Math.ceil(positives.length * fraction) - 1] : 1;
  const thresholds = [quantile(.25), quantile(.5), quantile(.75)];
  const bandLayouts = bands.map((days, index) => {
    const first = new Date(`${days[0].date}T00:00:00Z`);
    const offset = mobile && index === 0 ? first.getUTCDay() : mobile ? first.getUTCDay() : leading;
    const cells = days.map((day) => {
      const d = new Date(`${day.date}T00:00:00Z`);
      const col = Math.floor((offset + (d - first) / 86400000) / 7);
      const row = d.getUTCDay();
      return { day, col, row };
    });
    return { days, cells, weeks: Math.max(...cells.map((cell) => cell.col)) + 1 };
  });
  const graphWidth = Math.max(...bandLayouts.map((band) => band.weeks)) * step;
  const graphHeight = 7 * step;
  const bandHeight = graphHeight + 24;
  const graphHeightTotal = bandLayouts.length * bandHeight + (bandLayouts.length - 1) * bandGap;
  const width = labelWidth + graphWidth + 25;
  const height = top + graphHeightTotal + 72;
  const total = data.totalContributions.toLocaleString('en-US');
  const accounts = data.accounts.length;
  const headings = `<text x="${labelWidth}" y="50" class="total"><tspan font-size="30">${total}</tspan><tspan dx="8" font-size="12">contributions</tspan></text><text x="${labelWidth}" y="73" class="meta">${data.activeDays.toLocaleString('en-US')} active days  ·  ${accounts} accounts combined</text><text x="${labelWidth}" y="92" class="range">${esc(displayDate(data.from))} — ${esc(displayDate(data.to))}</text>`;
  const labels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const svgDays = bandLayouts.map((band, index) => {
    const yBase = top + index * (bandHeight + bandGap);
    const monthTexts = [];
    let previousMonth = '';
    for (const cell of band.cells) {
      const month = cell.day.date.slice(0, 7);
      if (month !== previousMonth && cell.row < 4) {
        monthTexts.push(`<text x="${labelWidth + cell.col * step}" y="${yBase - 7}" class="month">${esc(monthLabel(cell.day.date))}</text>`);
        previousMonth = month;
      }
    }
    const weekdayLabels = labels.map((label, row) => label ? `<text x="0" y="${yBase + row * step + daySize - 1}" class="weekday">${label}</text>` : '').join('');
    const rects = band.cells.map(({ day, col, row }) => {
      const shade = level(day.count, thresholds);
      const color = shade ? COLORS.ramp[shade - 1] : COLORS.empty;
      return `<rect x="${labelWidth + col * step}" y="${yBase + row * step}" width="${daySize}" height="${daySize}" rx="2" fill="${color}"><title>${esc(day.date)}: ${day.count} ${day.count === 1 ? 'contribution' : 'contributions'}</title></rect>`;
    }).join('');
    return `${monthTexts.join('')}${weekdayLabels}${rects}`;
  }).join('');
  const footerY = top + graphHeightTotal + 18;
  const legendX = width / 2 - 41;
  const legend = `<text x="${legendX - 20}" y="${footerY + 19}" text-anchor="end" class="note">Less</text>${COLORS.ramp.map((color, index) => `<rect x="${legendX + index * 12}" y="${footerY + 9}" width="9" height="9" rx="2" fill="${color}"/>`).join('')}<text x="${legendX + 53}" y="${footerY + 19}" class="note">More</text>`;
  const footer = `<text x="${labelWidth}" y="${footerY}" class="note">Includes private contributions</text><text x="${width - 12}" y="${footerY}" text-anchor="end" class="note">Updated ${esc(displayDate(data.generatedAt.slice(0, 10)))}</text>${legend}`;
  const aria = `${total} contributions across ${accounts} accounts from ${displayDate(data.from)} to ${displayDate(data.to)}, with ${data.activeDays} active days.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">Combined GitHub contributions</title><desc id="desc">${esc(aria)}</desc><style>.bg{fill:${COLORS.bg}}.total{font:700 30px system-ui,sans-serif;fill:${COLORS.fg}}.meta{font:12px system-ui,sans-serif;fill:${COLORS.fg}}.range{font:11px system-ui,sans-serif;fill:${COLORS.secondary}}.month{font:10px system-ui,sans-serif;fill:${COLORS.fg}}.weekday{font:9px system-ui,sans-serif;fill:${COLORS.secondary}}.note{font:10px system-ui,sans-serif;fill:${COLORS.secondary}}</style><rect class="bg" x="0" y="0" width="100%" height="100%" rx="14"/>${headings}${svgDays}${footer}</svg>`;
}

export function renderSvg(data, mobile = false) { return svgHeatmap(data, mobile); }

async function replaceOutputs(contents, root) {
  const staging = path.join(root, `.contributions-stage-${process.pid}`);
  const backup = path.join(root, `.contributions-backup-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  try {
    for (const [relative, content] of Object.entries(contents)) {
      const staged = path.join(staging, relative);
      await mkdir(path.dirname(staged), { recursive: true });
      await writeFile(staged, content, 'utf8');
    }
  } catch {
    await rm(staging, { recursive: true, force: true });
    throw new Error('Could not stage contribution assets.');
  }
  const existed = new Map();
  for (const relative of OUTPUTS) {
    try { await readFile(path.join(root, relative)); existed.set(relative, true); }
    catch (error) { if (error.code === 'ENOENT') existed.set(relative, false); else throw error; }
  }
  let backedUp = true;
  try {
    for (const relative of OUTPUTS) {
      const destination = path.join(root, relative);
      try { await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
      const saved = path.join(backup, relative);
      await mkdir(path.dirname(saved), { recursive: true });
      await rename(destination, saved);
    }
    for (const relative of OUTPUTS) {
      const destination = path.join(root, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(path.join(staging, relative), destination);
    }
  } catch (error) {
    if (backedUp) {
      for (const relative of OUTPUTS) {
        const saved = path.join(backup, relative);
        const destination = path.join(root, relative);
        if (existed.get(relative)) {
          try { await readFile(saved); await rm(destination, { force: true }); await mkdir(path.dirname(destination), { recursive: true }); await rename(saved, destination); } catch {}
        } else {
          await rm(destination, { force: true });
        }
      }
    }
    throw new Error('Could not safely replace contribution assets.');
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}

export async function updateContributions({ root = ROOT, env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  const config = JSON.parse(await readFile(path.join(root, 'accounts.json'), 'utf8'));
  if (!Array.isArray(config.accounts) || config.accounts.length < 1 || config.accounts.some((item) => !item.login || !item.tokenEnv)) {
    throw new Error('accounts.json must define account identities and token names.');
  }
  const seenLogins = new Set();
  const accounts = config.accounts.map((account) => {
    const key = account.login.toLowerCase();
    if (seenLogins.has(key)) throw new Error('accounts.json contains duplicate account identities.');
    seenLogins.add(key);
    return account;
  });
  const tokens = accounts.map((account) => {
    const token = env[account.tokenEnv];
    if (typeof token !== 'string' || !token.trim()) throw new Error(`Missing required Actions secret ${account.tokenEnv}.`);
    return token;
  });
  const window = utcDateWindow(now);
  const results = await Promise.all(accounts.map((account, index) => fetchAccount(account, tokens[index], window, fetchImpl)));
  const data = aggregateAccounts(results, window, now.toISOString());
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await replaceOutputs({
    [OUTPUTS[0]]: json,
    [OUTPUTS[1]]: renderSvg(data),
    [OUTPUTS[2]]: renderSvg(data, true)
  }, root);
  return data;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  updateContributions().then((data) => {
    process.stdout.write(`Updated combined contribution graph (${data.totalContributions} contributions).\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
