import { describe, expect, test } from 'vitest';
import { deviceStatus, filterCounts, filterDevices, placeLabel, sortDevices } from './devices.js';

const d = (over) => ({ id: 'x', name: 'PC', status: 'active', siteId: null, access: 'ask', online: false, ...over });
const places = new Map([['s1', { name: "Hadar's Bakery", customer: 'Hadar Ltd' }]]);
const list = [
  d({ id: '1', name: 'Front counter', online: true, access: 'any', siteId: 's1' }),
  d({ id: '2', name: 'Back office', online: true, access: 'ask', siteId: 's1' }),
  d({ id: '3', name: 'Kitchen', online: false, access: 'any' }),
  d({ id: '4', name: 'New PC', status: 'pending' }),
];

describe('devices', () => {
  test('counts for each filter chip', () => {
    expect(filterCounts(list)).toEqual({ all: 4, online: 2, offline: 1, waiting: 1, any: 2, ask: 1 });
  });

  test('search matches the PC, its site and its customer, without caring about case', () => {
    const ids = (q, f = 'all') => filterDevices(list, places, q, f).map((x) => x.id);
    expect(ids('front')).toEqual(['1']);
    expect(ids('BAKERY')).toEqual(['1', '2']);
    expect(ids('hadar ltd')).toEqual(['1', '2']);
    expect(ids('')).toEqual(['1', '2', '3', '4']);
    expect(ids('', 'offline')).toEqual(['3']);
    expect(ids('', 'waiting')).toEqual(['4']);
    expect(ids('bakery', 'any')).toEqual(['1']);
    expect(ids('nothing')).toEqual([]);
  });

  test('waiting PCs sort first, then by name', () => {
    expect(sortDevices(list).map((x) => x.id)).toEqual(['4', '2', '1', '3']);
  });

  test('the mark and word of a row', () => {
    expect(deviceStatus(list[0], null)).toMatchObject({ mark: 'on', word: 'online' });
    expect(deviceStatus(list[2], null)).toMatchObject({ mark: 'off', word: 'offline' });
    expect(deviceStatus(list[3], null)).toMatchObject({ mark: 'wait', word: 'waiting' });
    expect(deviceStatus(list[0], { phase: 'connecting' })).toMatchObject({ mark: 'wait', word: 'connecting' });
    expect(deviceStatus(list[0], { phase: 'awaiting' })).toMatchObject({ word: 'asking' });
    expect(deviceStatus(list[0], { phase: 'live' })).toMatchObject({ mark: 'live', word: 'connected' });
    expect(placeLabel(list[0], places)).toBe("Hadar's Bakery");
    expect(placeLabel(list[2], places)).toBe('');
  });
});
