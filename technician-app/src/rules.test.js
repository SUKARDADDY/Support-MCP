import { describe, expect, test } from 'vitest';
import { ACTIONS, DEFAULT_DOC, changedFields, effective, folderProblem, hoursSummary, problemWith, teamDoc, timeZones } from './rules.js';

const HOURS = { mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'], fri: ['08:00', '13:00'] };

describe('the rules the screens work with', () => {
  test('a team with no saved rules has the relay\'s defaults', () => {
    expect(DEFAULT_DOC).toMatchObject({ time_zone: null, hours: null, restart: 'approve', shutdown: 'approve', install: 'approve', uninstall: 'approve', close_program: 'allow', protected_programs: [], protected_folders: [] });
    expect(teamDoc(undefined)).toEqual(DEFAULT_DOC);
    expect(teamDoc({ restart: 'never' })).toMatchObject({ restart: 'never', shutdown: 'approve' });
    // A copy: editing it never changes the defaults.
    teamDoc({}).protected_programs.push('x');
    expect(DEFAULT_DOC.protected_programs).toEqual([]);
  });

  test('a customer\'s field replaces the team\'s, a list replaces and never merges, and the zone falls back to the deployment\'s', () => {
    const team = { ...DEFAULT_DOC, hours: HOURS, restart: 'approve_in_hours', protected_programs: ['Outlook.exe'], time_zone: 'Asia/Jerusalem' };
    const got = effective(team, { restart: 'never', protected_programs: ['Sage.exe'] }, 'UTC');
    expect(got).toMatchObject({ restart: 'never', protected_programs: ['Sage.exe'], hours: HOURS, time_zone: 'Asia/Jerusalem', shutdown: 'approve' });
    expect(effective({ ...DEFAULT_DOC }, null, 'Europe/London').time_zone).toBe('Europe/London');
    expect(effective({ ...DEFAULT_DOC }, null).time_zone).toBe('UTC');
    expect(effective(team, { time_zone: null }, 'Europe/London').time_zone).toBe('Europe/London');
  });

  test('an hour value whose hours were dropped counts as never, never as looser', () => {
    const team = { ...DEFAULT_DOC, hours: HOURS, restart: 'approve_in_hours', install: 'outside_hours' };
    const dropped = effective(team, { hours: null }, 'UTC');
    expect(dropped).toMatchObject({ hours: null, restart: 'never', install: 'never', shutdown: 'approve' });
    for (const a of ACTIONS) expect(['approve_in_hours', 'outside_hours']).not.toContain(dropped[a]);
  });

  test('the platform\'s time zones come sorted with UTC among them', () => {
    const zones = timeZones();
    expect(zones).toContain('UTC');
    expect(zones).toContain('Asia/Jerusalem');
    expect([...zones].sort()).toEqual(zones);
  });

  test('what changed is found per field, a field set or unset counts, and the order days were opened in does not matter', () => {
    const before = { ...DEFAULT_DOC, hours: { mon: ['08:00', '18:00'], tue: ['08:00', '18:00'] } };
    expect(changedFields(before, { ...before })).toEqual([]);
    expect(changedFields(before, { ...before, hours: { tue: ['08:00', '18:00'], mon: ['08:00', '18:00'] } })).toEqual([]);
    expect(changedFields(before, { ...before, restart: 'never', protected_programs: ['a'] })).toEqual(['restart', 'protected_programs']);
    // A customer's override: a field that is there against one that is not.
    expect(changedFields({}, { restart: 'approve' })).toEqual(['restart']);
    expect(changedFields({ restart: 'approve' }, {})).toEqual(['restart']);
    expect(changedFields({ hours: null }, {})).toEqual(['hours']);
  });

  test('the first mistake a form can catch is told, in the order the screen reads', () => {
    const ok = { ...DEFAULT_DOC };
    expect(problemWith(ok, ok)).toBeNull();
    expect(problemWith({ ...ok, time_zone: 'Mars/Base' }, ok)).toMatchObject({ key: 'rules.err_zone' });
    expect(problemWith({ ...ok, time_zone: 'Asia/Jerusalem' }, { ...ok, time_zone: 'Asia/Jerusalem' })).toBeNull();
    expect(problemWith({ ...ok, hours: { mon: ['8', '18:00'] } }, ok)).toMatchObject({ key: 'rules.err_time', vars: { day: 'Monday' } });
    expect(problemWith({ ...ok, hours: { mon: ['18:00', '08:00'] } }, ok)).toMatchObject({ key: 'rules.err_order' });
    expect(problemWith({ ...ok, hours: { mon: ['18:00', '18:00'] } }, ok)).toMatchObject({ key: 'rules.err_order' });
    expect(problemWith({ ...ok, hours: { mon: ['08:00', '24:00'] } }, ok)).toBeNull();
    expect(problemWith({ ...ok, hours: {} }, ok)).toMatchObject({ key: 'rules.err_no_days' });
    expect(problemWith({ ...ok, restart: 'outside_hours' }, { ...ok, restart: 'outside_hours' })).toMatchObject({ key: 'rules.err_hours_needed', vars: { action: 'Restart the PC' } });
    // A customer's document is judged merged over the team's: hours from the team make an hour value fine.
    expect(problemWith({ restart: 'outside_hours' }, { ...ok, hours: HOURS, restart: 'outside_hours' })).toBeNull();
    expect(problemWith({ ...ok, protected_folders: ['Customer Data'] }, ok)).toMatchObject({ key: 'rules.err_folder' });
    expect(problemWith({ ...ok, protected_folders: ['C:\\Data', 'D:/Other'] }, ok)).toBeNull();
    // A whole drive would refuse every file and installer of the PC.
    for (const root of ['C:\\', 'c:/', 'D:\\\\']) expect(problemWith({ ...ok, protected_folders: [root] }, ok)).toMatchObject({ key: 'rules.err_folder_root' });
    expect(problemWith({ ...ok, protected_programs: Array.from({ length: 51 }, (_, i) => `p${i}`) }, ok)).toMatchObject({ key: 'rules.err_list_long' });
  });

  test('a protected folder may be a Mac path, as the relay accepts it', () => {
    const ok = { ...DEFAULT_DOC };
    const with_ = (folder) => problemWith({ ...ok, protected_folders: [folder] }, ok);
    for (const good of ['/Users/ariel/Documents', '/Volumes/My Data', ' /Users/ariel/Customer Data ', '/Data']) expect(with_(good), good).toBeNull();
    for (const bad of ['Users/x', '~/Documents', '//server/share', '///x', '\\Users\\x']) expect(with_(bad), bad).toMatchObject({ key: 'rules.err_folder' });
    for (const bad of ['/a/../b', '/a/./b', '/..', '/a\u0000b']) expect(with_(bad), bad).toMatchObject({ key: 'rules.err_folder_posix' });
    expect(with_('/')).toMatchObject({ key: 'rules.err_folder_root' });
    // A drive path is checked as it was.
    expect(with_('C:\\Data')).toBeNull();
    expect(with_('C:\\')).toMatchObject({ key: 'rules.err_folder_root' });
    expect(folderProblem('/Users/ariel/Documents')).toBeNull();
    expect(folderProblem('Users/x')).toMatchObject({ key: 'rules.err_folder', vars: { path: 'Users/x' } });
  });

  test('business hours read as a line, with days that follow each other with the same times grouped', () => {
    expect(hoursSummary(null)).toBe('No business hours');
    expect(hoursSummary(HOURS)).toBe('Monday to Wednesday 08:00 to 18:00, Friday 08:00 to 13:00');
    expect(hoursSummary({ mon: ['08:00', '18:00'], wed: ['08:00', '18:00'] })).toBe('Monday 08:00 to 18:00, Wednesday 08:00 to 18:00');
    expect(hoursSummary({ sun: ['09:00', '24:00'] })).toBe('Sunday 09:00 to 24:00');
  });

  test('the week is a circle: Sunday groups with Monday and with Saturday', () => {
    const long = ['07:30', '20:00'];
    const sunThu = { sun: long, mon: long, tue: long, wed: long, thu: long, fri: ['08:00', '13:00'] };
    expect(hoursSummary(sunThu)).toBe('Sunday to Thursday 07:30 to 20:00, Friday 08:00 to 13:00');
    expect(hoursSummary({ sun: long, mon: long })).toBe('Sunday to Monday 07:30 to 20:00');
    expect(hoursSummary({ fri: long, sat: long, sun: long, mon: long, wed: ['09:00', '10:00'] })).toBe('Friday to Monday 07:30 to 20:00, Wednesday 09:00 to 10:00');
    expect(hoursSummary({ mon: long, sat: long })).toBe('Monday 07:30 to 20:00, Saturday 07:30 to 20:00');
    expect(hoursSummary({ sat: long, sun: ['09:00', '12:00'] })).toBe('Saturday 07:30 to 20:00, Sunday 09:00 to 12:00');
    expect(hoursSummary(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, long])))).toBe('Monday to Sunday 07:30 to 20:00');
    expect(hoursSummary({ mon: long, tue: long, sun: ['09:00', '12:00'] })).toBe('Monday to Tuesday 07:30 to 20:00, Sunday 09:00 to 12:00');
  });
});
