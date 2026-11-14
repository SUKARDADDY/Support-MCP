// The rules model (src/rules.js), run against the shared cases in test/fixtures/rules-cases.json. The PC
// app runs the "decide" cases of the same file against its own copy of decide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_RULES, REFUSALS, RulesError, decide, effectiveRules, hoursUtc, installArgsProblem, installerProblem, isAppPath, isTimeZone, parseRules, parseStored, pathInside, resolveTimeZone, rulesTag,
} from '../src/rules.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/rules-cases.json', import.meta.url), 'utf8'));

test('the shared file has the cases the plan names', () => {
  assert.ok(cases.decide.length >= 60);
  assert.ok(cases.decide_posix.length >= 20);
  for (const k of ['decide', 'hours', 'effective', 'validate', 'installers']) assert.ok(cases[k].length > 5, k);
  assert.equal(new Set(Object.values(cases).filter(Array.isArray).flat().map((c) => c.name)).size, Object.values(cases).filter(Array.isArray).flat().length, 'case names are unique');
});

for (const c of cases.decide) {
  test(`decide: ${c.name}`, () => {
    const ctx = { nowMs: c.now * 1000, hours: { hours_utc: c.hours_utc, hours_until: c.hours_until }, ...c.args };
    const got = decide(c.rules, c.action, ctx);
    if (c.expect.outcome === 'refuse') assert.deepEqual(got, { refuse: c.expect.code, text: REFUSALS[c.expect.code] });
    else assert.deepEqual(got, { [c.expect.outcome]: true });
    // The spans in the case are the ones the relay works out for its answer, 8 days ending at hours_until.
    assert.deepEqual(hoursUtc(c.rules, (c.hours_until - 8 * 86400) * 1000), { hours_utc: c.hours_utc, hours_until: c.hours_until });
  });
}

// The Mac's cases: the same shape, run here and by the Mac client. The Windows PC reads only "decide" and "installers".
for (const c of cases.decide_posix) {
  test(`decide (posix): ${c.name}`, () => {
    const ctx = { nowMs: c.now * 1000, hours: { hours_utc: c.hours_utc, hours_until: c.hours_until }, ...c.args };
    const got = decide(c.rules, c.action, ctx);
    if (c.expect.outcome === 'refuse') assert.deepEqual(got, { refuse: c.expect.code, text: REFUSALS[c.expect.code] });
    else assert.deepEqual(got, { [c.expect.outcome]: true });
    for (const f of c.rules.protected_folders) assert.doesNotThrow(() => parseRules({ protected_folders: [f] }), f);
  });
}

test('a protected folder may be a Mac path: one leading /, no . or .. part, not the whole disk, still 260 characters at most', () => {
  const folders = (list) => parseRules({ protected_folders: list }).protected_folders;
  assert.deepEqual(folders(['/Users/ariel/Documents']), ['/Users/ariel/Documents']);
  assert.deepEqual(folders(['/Volumes/My Data', 'C:\\Data', '/Users/ariel/Ünï cødé', '/a/b?c*d']), ['/Volumes/My Data', 'C:\\Data', '/Users/ariel/Ünï cødé', '/a/b?c*d'], 'a Mac name may hold ? and *, which a Windows one may not');
  assert.deepEqual(folders(['/Data', '/data']), ['/Data'], 'the same folder twice, by case');
  assert.deepEqual(folders([`/${'a'.repeat(259)}`]).length, 1);
  const refused = [
    ['Users/x', /absolute local paths/],
    ['~/Documents', /absolute local paths/],
    ['/a/../b', /\. or \.\. parts/],
    ['/a/./b', /\. or \.\. parts/],
    ['/..', /\. or \.\. parts/],
    ['//server/share', /absolute local paths/],
    ['///x', /absolute local paths/],
    ['/', /whole disk/],
    ['/ ', /whole disk/],
    ['/a\u0000b', /control characters/],
    ['/a\nb', /control characters/],
    [`/${'a'.repeat(260)}`, /1 to 260/],
    ['\\Users\\x', /absolute local paths/],
  ];
  for (const [folder, message] of refused) {
    assert.throws(() => parseRules({ protected_folders: [folder] }), (e) => e instanceof RulesError && message.test(e.message), JSON.stringify(folder));
  }
  // The Windows rules are as they were.
  for (const folder of ['C:\\', 'D:/', 'C:\\a\\..\\b', 'C:\\a?b']) assert.throws(() => parseRules({ protected_folders: [folder] }), RulesError, folder);
});

test('pathInside and isAppPath on Mac paths: case-folded, .. resolved from the root, nothing shared with Windows names', () => {
  assert.equal(pathInside('/Users/ariel/Docs', '/users/ARIEL/docs/a/b.txt'), true);
  assert.equal(pathInside('/Users/ariel/Docs', '/Users/ariel/Docs2/a.txt'), false);
  assert.equal(pathInside('/Data', '/x/../data/a.txt'), true, 'a .. may take away the first part of a Mac path');
  assert.equal(pathInside('/Data', '/../data/a.txt'), true, 'and above the root it stays at the root');
  assert.equal(pathInside('/Data', 'C:\\Data\\a.txt'), false);
  assert.equal(pathInside('C:\\Data', '/Data/a.txt'), false);
  for (const path of ['/Applications/Support.app', '/Applications/Support.app/Contents/MacOS/support', '/applications/support.app/x', '/Library/Application Support/SupportMCP', '/Library/Application Support/SupportMCP/staging/x', '/x/../Applications/Support.app/y']) {
    assert.equal(isAppPath(path), true, path);
  }
  for (const path of ['/Applications', '/Applications/Other.app/x', '/Applications/Support.app.bak/x', '/Library/Application Support/Other', '/Library/Application Support', '/Users/a/Library/Application Support/SupportMCP', 'Applications/Support.app', '/']) {
    assert.equal(isAppPath(path), false, path);
  }
  // The Windows rule is as it was, and a drive path never reads as a Mac one.
  assert.equal(isAppPath('C:\\Program Files\\SupportMCP\\support.exe'), true);
  assert.equal(isAppPath('C:\\Applications\\Support.app\\x'), false);
});

for (const c of cases.installers) {
  test(`installer: ${c.name}`, () => {
    assert.equal((installerProblem(c.path) ?? installArgsProblem(c.path, c.args)) !== null, c.problem);
  });
}

for (const c of cases.hours) {
  test(`hours: ${c.name}`, () => {
    assert.deepEqual(hoursUtc(c.rules, c.now * 1000), c.expect);
  });
}

for (const c of cases.effective) {
  test(`effective: ${c.name}`, () => {
    const team = c.team === null ? null : parseRules(c.team);
    const customer = c.customer === null ? null : parseRules(c.customer, { override: true });
    assert.deepEqual(effectiveRules(team, customer, { defaultTimeZone: c.default_time_zone, rev: c.rev }), c.expect);
  });
}

for (const c of cases.validate) {
  test(`validate: ${c.name}`, () => {
    const run = () => parseRules(c.doc, { override: c.scope === 'override' });
    if (c.ok) {
      const got = run();
      if (c.normalized) assert.deepEqual(got, c.normalized);
      assert.deepEqual(parseRules(got, { override: c.scope === 'override' }), got, 'parsing a parsed document changes nothing');
    } else {
      assert.throws(run, (e) => e instanceof RulesError && e.message.includes(c.error), c.error);
    }
  });
}

test('the horizon is 8 days from the whole second', () => {
  const rules = { time_zone: 'UTC', hours: { thu: ['10:00', '11:00'] } };
  assert.deepEqual(hoursUtc(rules, 1_794_873_600_900), hoursUtc(rules, 1_794_873_600_000));
  assert.equal(hoursUtc(rules, 1_794_873_600_900).hours_until, 1_794_873_600 + 8 * 86400);
});

test('decide works the hours out itself when the caller gives none', () => {
  const rules = effectiveRules(parseRules({ restart: 'outside_hours', hours: { tue: ['08:00', '18:00'] }, time_zone: 'UTC' }));
  assert.deepEqual(decide(rules, 'restart', { nowMs: Date.parse('2026-11-10T10:00:00Z') }), { refuse: 'business_hours', text: REFUSALS.business_hours });
  assert.deepEqual(decide(rules, 'restart', { nowMs: Date.parse('2026-11-10T19:00:00Z') }), { allow: true });
  assert.deepEqual(decide(rules, 'restart', { nowMs: Date.parse('2026-11-11T10:00:00Z') }), { allow: true });
});

test('decide refuses a name that is not an action', () => {
  assert.throws(() => decide(effectiveRules(null), 'format_disk'), TypeError);
});

test('the defaults are the plan\'s: power and software need approval, closing is allowed', () => {
  assert.deepEqual(parseRules({}), DEFAULT_RULES);
  assert.deepEqual(effectiveRules(null).restart, 'approve');
  assert.equal(effectiveRules(null).close_program, 'allow');
  assert.equal(effectiveRules(null).time_zone, 'UTC');
  assert.deepEqual(effectiveRules(null).hours, null);
});

test('time zones: the names Intl lists and UTC, the deployment\'s as the fallback, else UTC', () => {
  assert.ok(isTimeZone('Asia/Jerusalem') && isTimeZone('America/New_York') && isTimeZone('UTC'));
  for (const no of ['', 'asia/jerusalem', 'Mars/Base', 'US/Eastern', null, 5, undefined]) assert.equal(isTimeZone(no), false, String(no));
  assert.equal(resolveTimeZone(null, 'Asia/Jerusalem'), 'Asia/Jerusalem');
  assert.equal(resolveTimeZone('America/New_York', 'Asia/Jerusalem'), 'America/New_York');
  assert.equal(resolveTimeZone(null, ' Asia/Jerusalem '), 'Asia/Jerusalem');
  assert.equal(resolveTimeZone(null, 'Mars/Base'), 'UTC');
  assert.equal(resolveTimeZone(null), 'UTC');
});

test('a damaged stored document is the defaults, or nothing for an override, never an error', () => {
  assert.deepEqual(parseStored('{not json'), DEFAULT_RULES);
  assert.deepEqual(parseStored('{"restart":"banana"}'), DEFAULT_RULES);
  assert.deepEqual(parseStored('{not json', { override: true }), {});
  assert.deepEqual(parseStored('{"restart":"never"}', { override: true }), { restart: 'never' });
});

test('rulesTag: stable, content only, and it moves with the resolved time zone', async () => {
  const a = effectiveRules(parseRules({ restart: 'never', protected_programs: ['x'] }), null, { defaultTimeZone: 'Asia/Jerusalem', rev: 1 });
  const same = effectiveRules(parseRules({ protected_programs: ['x'], restart: 'never' }), null, { defaultTimeZone: 'Asia/Jerusalem', rev: 9 });
  assert.match(await rulesTag(a), /^[0-9a-f]{16}$/);
  assert.equal(await rulesTag(a), await rulesTag(same), 'field order and rev do not matter');
  assert.notEqual(await rulesTag(a), await rulesTag(effectiveRules(parseRules({ restart: 'allow', protected_programs: ['x'] }), null, { defaultTimeZone: 'Asia/Jerusalem' })));
  assert.notEqual(await rulesTag(a), await rulesTag(effectiveRules(parseRules({ restart: 'never', protected_programs: ['x'] }), null, { defaultTimeZone: 'America/New_York' })), 'a new DEFAULT_TIME_ZONE changes the tag');
  assert.notEqual(await rulesTag(a), await rulesTag(effectiveRules(parseRules({ restart: 'never', protected_programs: ['y'] }), null, { defaultTimeZone: 'Asia/Jerusalem' })));
});

test('pathInside compares whole components', () => {
  assert.equal(pathInside('C:\\Data', 'C:\\Data\\a\\b'), true);
  assert.equal(pathInside('C:\\Data', 'C:\\Database'), false);
  assert.equal(pathInside('C:\\Data\\', 'c:/data'), true);
  assert.equal(pathInside('C:\\Data', 'C:\\'), false);
  assert.equal(pathInside('', 'C:\\Data'), false);
});

test('a PC checking in many times a second can afford hoursUtc', () => {
  const rules = effectiveRules(parseRules({ restart: 'outside_hours', time_zone: 'Asia/Jerusalem', hours: { sun: ['08:00', '18:00'], mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'], thu: ['08:00', '18:00'], fri: ['08:00', '13:00'] } }));
  const t = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) hoursUtc(rules, Date.UTC(2026, 9, 20) + i * 3_600_000);
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / 200;
  assert.ok(ms < 5, `${ms} ms a call`);
});
