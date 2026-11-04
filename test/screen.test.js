// The screen vocabulary: action normalization, audit text and result validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import {
  normalizeAction, auditText, decodeScreenResult, decodeControlResult, decodePollReport, decodeCaps, IMAGE_B64_MAX,
} from '../src/screen.js';

const JPEG = '/9j/4AAQ';
const PNG = 'iVBORw0KGgoAAAAA';
const shot = (extra = {}) => ({ ok: true, image_b64: JPEG, mime: 'image/jpeg', width: 1280, height: 800, display: 0, displays: 2, desktop: 'default', ...extra });

test('normalizeAction fills defaults, rounds numbers and drops unknown fields', () => {
  assert.deepEqual(normalizeAction({ name: 'click', x: 10.4, y: 20.6, extra: 1 }), { name: 'click', x: 10, y: 21, button: 'left', count: 1, display: 0, screenshot: true });
  assert.deepEqual(normalizeAction({ name: 'scroll', x: 1, y: 2, direction: 'left' }).amount, 3);
  assert.deepEqual(normalizeAction({ name: 'wait' }), { name: 'wait', seconds: 1, display: 0, screenshot: true });
  assert.equal(normalizeAction({ name: 'wait', seconds: 0.04 }).seconds, 0.1);
  assert.deepEqual(normalizeAction({ name: 'block_input', on: true }), { name: 'block_input', on: true, minutes: 10 });
  assert.deepEqual(normalizeAction({ name: 'block_input', on: false, minutes: 5 }), { name: 'block_input', on: false });
  assert.equal(normalizeAction({ name: 'ui_act', ref: '12', verb: 'toggle', value: 'ignored' }).ref, 12);
  assert.equal('value' in normalizeAction({ name: 'ui_act', ref: 1, verb: 'toggle', value: 'x' }), false);
  assert.equal(normalizeAction({ name: 'ui_act', ref: 1, verb: 'set_value', value: 'x' }).value, 'x');
  assert.equal(normalizeAction({ name: 'type', text: 'a', screenshot: false }).screenshot, false);
  // screenshot and zoom never append a screenshot of their own
  assert.equal('screenshot' in normalizeAction({ name: 'screenshot' }), false);
  assert.equal('screenshot' in normalizeAction({ name: 'zoom', x1: 0, y1: 0, x2: 5, y2: 5 }), false);
});

test('normalizeAction rejects bad input with an error that never repeats the value', () => {
  const bad = [
    null, [], {}, { name: 'nope' }, { name: 'click', x: 'a', y: 1 }, { name: 'click', x: -1, y: 1 }, { name: 'click', x: 20001, y: 1 },
    { name: 'click', x: 1, y: NaN }, { name: 'click', x: 1, y: 1, button: 'back' }, { name: 'click', x: 1, y: 1, count: 4 },
    { name: 'click', x: 1, y: 1, screenshot: 'yes' }, { name: 'click', x: 1, y: 1, display: 16 },
    { name: 'scroll', x: 1, y: 1, direction: 'sideways' }, { name: 'scroll', x: 1, y: 1, direction: 'up', amount: 51 },
    { name: 'type', text: '' }, { name: 'type', text: 'x'.repeat(5001) }, { name: 'type', text: 5 },
    { name: 'key', keys: '' }, { name: 'key', keys: 'x'.repeat(101) }, { name: 'key', keys: 'a\nb' },
    { name: 'wait', seconds: 0 }, { name: 'wait', seconds: 11 }, { name: 'wait', seconds: '2' },
    { name: 'zoom', x1: 5, y1: 5, x2: 5, y2: 9 }, { name: 'zoom', x1: 5, y1: 5, x2: 9, y2: 1 },
    { name: 'ui_tree', max_lines: 0 }, { name: 'ui_tree', max_lines: 2001 },
    { name: 'ui_act', ref: -1, verb: 'invoke' }, { name: 'ui_act', ref: 1, verb: 'kick' }, { name: 'ui_act', ref: 1, verb: 'set_value' },
    { name: 'ui_act', ref: 1, verb: 'set_value', value: 'x'.repeat(5001) },
    { name: 'block_input' }, { name: 'block_input', on: 'yes' }, { name: 'block_input', on: true, minutes: 11 }, { name: 'block_input', on: true, minutes: 0 },
    { name: 'type_secret', text: '' }, { name: 'type_secret', text: 'x'.repeat(1001) },
  ];
  for (const raw of bad) assert.throws(() => normalizeAction(raw), Error, JSON.stringify(raw));
  const secret = 'S3cr3t-value'.repeat(100);
  assert.throws(() => normalizeAction({ name: 'type_secret', text: secret }), (e) => !e.message.includes('S3cr3t'));
  assert.throws(() => normalizeAction({ name: 'key', keys: `${secret}\n` }), (e) => !e.message.includes('S3cr3t'));
});

test('audit text: typed text is a length, type_secret is a bare name, ui_act has no value', () => {
  const t = (raw) => auditText(normalizeAction(raw));
  assert.equal(t({ name: 'click', x: 640, y: 412 }), 'click 640,412');
  assert.equal(t({ name: 'click', x: 1, y: 2, button: 'right', count: 2 }), 'click 1,2 right x2');
  assert.equal(t({ name: 'move', x: 5, y: 6 }), 'move 5,6');
  assert.equal(t({ name: 'drag', x1: 1, y1: 2, x2: 3, y2: 4 }), 'drag 1,2 3,4');
  assert.equal(t({ name: 'scroll', x: 5, y: 6, direction: 'down', amount: 4 }), 'scroll down 4 at 5,6');
  assert.equal(t({ name: 'type', text: 'hello שלום' }), 'type 10 chars');
  assert.equal(t({ name: 'key', keys: 'ctrl+s' }), 'key ctrl+s');
  assert.equal(t({ name: 'wait', seconds: 2 }), 'wait 2s');
  assert.equal(t({ name: 'zoom', x1: 1, y1: 2, x2: 3, y2: 4 }), 'zoom 1,2,3,4');
  assert.equal(t({ name: 'ui_tree' }), 'ui_tree');
  assert.equal(t({ name: 'ui_act', ref: 12, verb: 'invoke' }), 'ui_act invoke 12');
  assert.equal(t({ name: 'ui_act', ref: 12, verb: 'set_value', value: 'hunter2' }), 'ui_act set_value 12');
  assert.equal(t({ name: 'block_input', on: true, minutes: 10 }), 'block_input on 10m');
  assert.equal(t({ name: 'block_input', on: false }), 'block_input off');
  assert.equal(t({ name: 'send_sas' }), 'send_sas');
  assert.equal(t({ name: 'type_secret', text: 'hunter2' }), 'type_secret');
  assert.equal(t({ name: 'type_secret', text: 'hunter2', display: 1 }), 'type_secret');
  assert.equal(t({ name: 'click', x: 1, y: 2, display: 1 }), 'click 1,2 display 1');
});

test('a good screenshot result passes and is copied field by field', () => {
  assert.deepEqual(decodeScreenResult(shot({ extra: 'dropped', error: 'dropped' }), 'screenshot'), shot());
  assert.equal(decodeScreenResult(shot({ image_b64: PNG, mime: 'image/png' }), 'zoom').mime, 'image/png');
  // nulls count as absent
  assert.equal(decodeScreenResult({ ok: true, image_b64: null, mime: null, width: null, height: null, text: null, desktop: null }, 'click').ok, true);
  assert.deepEqual(decodeScreenResult({ ok: true, text: 'tree', desktop: 'secure' }, 'ui_tree'), { ok: true, text: 'tree', desktop: 'secure' });
  // the largest image allowed
  const max = '/9j/' + 'A'.repeat(IMAGE_B64_MAX - 4);
  assert.equal(decodeScreenResult(shot({ image_b64: max }), 'screenshot').image_b64.length, IMAGE_B64_MAX);
});

test('decodeScreenResult rejects every bad field', () => {
  const bad = {
    'not ok:true': { ...shot(), ok: 'yes' },
    'image too long': shot({ image_b64: '/9j/' + 'A'.repeat(IMAGE_B64_MAX) }),
    'image not a string': shot({ image_b64: 5 }),
    'image not base64': shot({ image_b64: '/9j/4A!Q' }),
    'image bad length': shot({ image_b64: '/9j/4AA' }),
    'image padding in the middle': shot({ image_b64: '/9j/=AAA' }),
    'image is a GIF': shot({ image_b64: 'R0lGODlh', mime: 'image/gif' }),
    'mime says png, bytes are jpeg': shot({ mime: 'image/png' }),
    'mime says jpeg, bytes are png': shot({ image_b64: PNG }),
    'no mime': shot({ mime: undefined }),
    'no width': shot({ width: undefined }),
    'width zero': shot({ width: 0 }),
    'width float': shot({ width: 12.5 }),
    'width as string': shot({ width: '1280' }),
    'height huge': shot({ height: 9000 }),
    'mime without image': { ok: true, mime: 'image/png' },
    'display negative': shot({ display: -1 }),
    'display float': shot({ display: 0.5 }),
    'displays zero': shot({ displays: 0 }),
    'display not below displays': shot({ display: 2, displays: 2 }),
    'desktop unknown word': shot({ desktop: 'winlogon' }),
    'text not a string': shot({ text: 7 }),
    'text too long': { ok: true, text: 'x'.repeat(200001), image_b64: undefined },
  };
  for (const [why, b] of Object.entries(bad)) assert.throws(() => decodeScreenResult(b, 'click'), Error, why);
  assert.throws(() => decodeScreenResult({ ok: true }, 'screenshot'), /missing image/);
  assert.throws(() => decodeScreenResult({ ok: true }, 'zoom'), /missing image/);
  assert.throws(() => decodeScreenResult({ ok: true }, 'ui_tree'), /missing text/);
});

test('control results, poll reports and caps are validated', () => {
  assert.deepEqual(decodeControlResult({ ok: true, control: 'full', desktop: 'default', text: 'ok', image_b64: JPEG }), { ok: true, control: 'full', desktop: 'default', text: 'ok' });
  assert.throws(() => decodeControlResult({ ok: true, control: 'root' }));
  assert.throws(() => decodeControlResult({ ok: true, text: 'x'.repeat(2001) }));
  assert.deepEqual(decodePollReport({ type: 'poll' }), {});
  assert.deepEqual(decodePollReport({ desktop: 'secure', paused_until: 1700000000000, input_blocked_until: null }), { desktop: 'secure', paused_until: 1700000000000, input_blocked_until: null });
  assert.deepEqual(decodePollReport({ desktop: 'x', paused_until: -5, input_blocked_until: 1.5 }), { desktop: null, paused_until: null, input_blocked_until: null });
  assert.deepEqual(decodeCaps(['lanes', 'screen', 'bogus', 'full', 'lanes']), ['screen', 'lanes', 'full']);
  assert.deepEqual(decodeCaps('lanes'), []);
  assert.deepEqual(decodeCaps(undefined), []);
});

test('no source file logs, so tool arguments and results can not reach a log', async () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.js'))) {
    assert.ok(!/\bconsole\.[a-z]/.test(await readFile(new URL(f, dir), 'utf8')), `${f} uses console`);
  }
});
