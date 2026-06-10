import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRuntimeResponsePayload,
  buildRuntimeUpdatePayload,
} from './runtime-host-protocol.ts';

test('buildRuntimeUpdatePayload normalizes missing runtime data', () => {
  const payload = buildRuntimeUpdatePayload(undefined, undefined);

  assert.deepEqual(payload, {
    type: 'xrp-runtime-update',
    runtime: {},
    variables: {},
    submission: null,
  });
});

test('buildRuntimeUpdatePayload forwards runtime submission state', () => {
  const runtime = {
    sessionId: 'session-1',
    submission: {
      status: 'streaming' as const,
      generationId: 'gen-1',
    },
  };
  const variables = { hp: 42 };

  const payload = buildRuntimeUpdatePayload(runtime, variables);

  assert.equal(payload.type, 'xrp-runtime-update');
  assert.equal(payload.runtime, runtime);
  assert.equal(payload.variables, variables);
  assert.deepEqual(payload.submission, runtime.submission);
});

test('buildRuntimeResponsePayload preserves request ids and null-defaults optional fields', () => {
  assert.deepEqual(
    buildRuntimeResponsePayload('req-1', true),
    {
      type: 'xrp-runtime-response',
      requestId: 'req-1',
      ok: true,
      payload: null,
      error: null,
    },
  );
});

test('buildRuntimeResponsePayload stringifies errors', () => {
  const payload = buildRuntimeResponsePayload('req-2', false, { retry: false }, new Error('boom').message);

  assert.deepEqual(payload, {
    type: 'xrp-runtime-response',
    requestId: 'req-2',
    ok: false,
    payload: { retry: false },
    error: 'boom',
  });
});
