import test from 'node:test';
import assert from 'node:assert/strict';
import { eventSource } from './events';
import { getTavernHelper } from './tavern-helper';
import type { StRuntimeStore } from './store';

function makeStore(): StRuntimeStore {
  return {
    chat: [],
    chatVariables: {},
    regexScripts: [],
    character: null,
    userName: 'user',
    sessionId: 'test-session',
    _version: 0,
    load: async () => {},
    loadLocal: () => {},
    reloadChatVariables: async () => {},
    getMessages: () => [],
    getVariables: () => ({}),
    getAllVariables: () => ({}),
    setVariables: () => {},
    setChatMessage: () => {},
    deleteVariable: () => {},
    replaceRegexScripts: () => {},
    subscribe: () => () => {},
    dispose: () => {},
  };
}

test('TavernHelper eventClearAll only removes subscriptions from the calling iframe', async () => {
  eventSource.clearAll();
  const helper = getTavernHelper(makeStore());
  const iframeA = { name: 'TH-script--a--1' } as Window;
  const iframeB = { name: 'TH-script--b--2' } as Window;
  let callsA = 0;
  let callsB = 0;

  helper._bind._eventOn.call(iframeA, 'fixture-event', () => { callsA += 1; });
  helper._bind._eventOn.call(iframeB, 'fixture-event', () => { callsB += 1; });

  await eventSource.emit('fixture-event');
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);

  helper._bind._eventClearAll.call(iframeA);
  await eventSource.emit('fixture-event');

  assert.equal(callsA, 1);
  assert.equal(callsB, 2);

  eventSource.clearAll();
});

test('normalizeTavernHelperScripts preserves content-field scripts and skips disabled or empty entries', async () => {
  const { normalizeTavernHelperScripts } = await import('./tavern-helper-scripts');

  assert.deepEqual(
    normalizeTavernHelperScripts([
      { name: '状态栏', id: 'status', content: 'console.log("status")', enabled: true },
      { name: 'disabled', id: 'off', content: 'console.log("off")', enabled: false },
      { name: 'empty', id: 'empty', content: '' },
      { name: 'legacy', id: 'legacy', code: 'console.log("legacy")' },
    ]),
    [
      { name: '状态栏', id: 'status', content: 'console.log("status")' },
      { name: 'legacy', id: 'legacy', content: 'console.log("legacy")' },
    ],
  );
});

test('TavernHelper script button API keeps registered buttons in memory', () => {
  const helper = getTavernHelper(makeStore());

  helper.replaceScriptButtons([]);
  helper.appendInexistentScriptButtons([
    { name: '重新处理变量', visible: false },
    { name: '重新处理变量', visible: true },
    { name: '快照楼层', visible: true },
  ]);

  assert.deepEqual(helper.getScriptButtons(), [
    { name: '重新处理变量', visible: false },
    { name: '快照楼层', visible: true },
  ]);
  assert.deepEqual(helper.getAllEnabledScriptButtons(), [
    { name: '快照楼层', visible: true },
  ]);
  assert.equal(helper.getButtonEvent('快照楼层'), 'script_button:快照楼层');
});
