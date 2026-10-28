import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aggregateAccounts, renderSvg, updateContributions, utcDateWindow } from '../scripts/update-contributions.mjs';

const accounts = [
  { login: 'Sahil24-lab', tokenEnv: 'CONTRIB_TOKEN_LAB' },
  { login: 'sahilh-tech', tokenEnv: 'CONTRIB_TOKEN_TECH' },
  { login: 'sahil-arobotix', tokenEnv: 'CONTRIB_TOKEN_AROBOTIX' },
  { login: 'sahil-actified', tokenEnv: 'CONTRIB_TOKEN_ACTIFIED' },
  { login: 'sahil-modais', tokenEnv: 'CONTRIB_TOKEN_MODAIS' }
];

function days(from, to, count) {
  const result = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    result.push({ date: cursor.toISOString().slice(0, 10), contributionCount: count });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function groups(input, size = 7) {
  return Array.from({ length: Math.ceil(input.length / size) }, (_, index) => ({ contributionDays: input.slice(index * size, (index + 1) * size) }));
}

function response(login, window, value, options = {}) {
  const contributionDays = days(window.from, window.to, value);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === 'x-oauth-scopes' ? 'read:user, repo' : null },
    json: async () => options.errors ? { errors: [{ message: 'private API detail' }] } : ({
      data: { viewer: {
        login,
        contributionsCollection: { restrictedContributionsCount: 9999, contributionCalendar: {
          totalContributions: options.badTotal ? 123 : value * contributionDays.length,
          weeks: groups(contributionDays)
        } }
      } }
    })
  };
}

function tokenEnv() {
  return Object.fromEntries(accounts.map(({ tokenEnv }, index) => [tokenEnv, `token-${index}`]));
}

function graphData(from = '2025-10-26', countAt = () => 1) {
  const days = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  for (let index = 0; index < 365; index++) {
    const date = cursor.toISOString().slice(0, 10);
    days.push({ date, count: countAt(index) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { from: days[0].date, to: days.at(-1).date, days, accounts: accounts.map(({ login }) => ({ login, totalContributions: 1 })), totalContributions: 999999, activeDays: days.filter(({ count }) => count > 0).length, generatedAt: '2026-10-28T00:00:00Z' };
}

test('requires configured identities and secrets before fetching', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-missing-'));
  try {
    await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ accounts: [] }));
    await assert.rejects(updateContributions({ root, env: tokenEnv(), fetchImpl: () => assert.fail('should not fetch') }), /account identities/);
    await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ accounts }));
    await assert.rejects(updateContributions({ root, env: {}, fetchImpl: () => assert.fail('should not fetch') }), /Missing required Actions secret/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aggregates daily counts and does not add the restricted subset again', () => {
  const window = { from: '2026-01-01', to: '2026-01-02' };
  const results = accounts.map(({ login }, index) => ({ login, dailyCounts: new Map([['2026-01-01', index + 1], ['2026-01-02', 0]]) }));
  const data = aggregateAccounts(results, window, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(data.days, [{ date: '2026-01-01', count: 15 }, { date: '2026-01-02', count: 0 }]);
  assert.equal(data.totalContributions, 15);
  assert.equal(data.activeDays, 1);
});

test('uses a 365-day UTC date window', () => {
  assert.deepEqual(utcDateWindow(new Date('2026-10-28T18:45:00.000Z')), { from: '2025-10-29', to: '2026-10-28' });
});

test('SVG weekday labels align to Monday, Wednesday, and Friday rows', () => {
  const svg = renderSvg(graphData('2025-10-26'));
  const labels = [...svg.matchAll(/<text x="0" y="(\d+)" class="weekday">(.*?)<\/text>/g)].map(([, y, label]) => [Number(y), label]);
  assert.deepEqual(labels.slice(0, 3), [[134, 'Mon'], [162, 'Wed'], [190, 'Fri']]);
});

test('mobile month headings have their own row, total label flows after number, and quantiles use all ramp levels', () => {
  const data = graphData('2025-10-29', (index) => [0, 1, 2, 3, 100][index] ?? 0);
  const svg = renderSvg(data, true);
  assert.match(svg, /<text x="27" y="50" class="total"><tspan font-size="30">999,999<\/tspan><tspan dx="8" font-size="12">contributions<\/tspan><\/text>/);
  assert.doesNotMatch(svg, /class="eyebrow"|class="band"|GITHUB ACTIVITY/);
  const monthY = [...svg.matchAll(/class="month">/g)].length;
  assert.ok(monthY > 0);
  const monthPositions = [...svg.matchAll(/<text x="\d+" y="(\d+)" class="month">/g)].map(([, y]) => Number(y));
  assert.ok(monthPositions.includes(103));
  assert.ok(monthPositions.some((y) => y > 200));
  for (const color of ['#123a43', '#0E534C', '#029F8C', '#07DFC1']) assert.ok(svg.includes(`fill="${color}"`));
});

test('identity mismatch and GraphQL failure stop before modifying any asset', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-preserve-'));
  const window = utcDateWindow(new Date('2026-10-28T12:00:00.000Z'));
  try {
    await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ accounts }));
    await mkdir(path.join(root, 'assets'));
    const outputs = ['contributions.json', 'contributions.svg', 'contributions-mobile.svg'];
    for (const name of outputs) await writeFile(path.join(root, 'assets', name), `old-${name}`);
    let calls = 0;
    const mismatch = async (_url, options) => {
      const index = calls++;
      const login = index === 0 ? 'someone-else' : accounts[index].login;
      return response(login, window, 1);
    };
    await assert.rejects(updateContributions({ root, env: tokenEnv(), fetchImpl: mismatch, now: new Date('2026-10-28T12:00:00.000Z') }), /identity did not match/);
    for (const name of outputs) assert.equal(await readFile(path.join(root, 'assets', name), 'utf8'), `old-${name}`);
    calls = 0;
    const graphqlFailure = async (_url, options) => {
      const index = calls++;
      return response(accounts[index].login, window, 1, { errors: true });
    };
    await assert.rejects(updateContributions({ root, env: tokenEnv(), fetchImpl: graphqlFailure, now: new Date('2026-10-28T12:00:00.000Z') }), /GraphQL failed/);
    for (const name of outputs) assert.equal(await readFile(path.join(root, 'assets', name), 'utf8'), `old-${name}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('validates each account total against its daily calendar', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-total-'));
  try {
    await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ accounts }));
    const window = utcDateWindow(new Date('2026-10-28T12:00:00.000Z'));
    await assert.rejects(updateContributions({ root, env: tokenEnv(), now: new Date('2026-10-28T12:00:00.000Z'), fetchImpl: async (_url, options) => {
      const index = Number(options.headers.authorization.slice(-1));
      return response(accounts[index].login, window, 1, { badTotal: index === 3 });
    } }), /totals did not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
