import type { SandboxRuntimeContext } from './sandbox-runtime-types';

export function buildRuntimeUpdatePayload(
  runtime?: SandboxRuntimeContext,
  variables?: Record<string, unknown>,
) {
  return {
    type: 'xrp-runtime-update',
    runtime: runtime || {},
    variables: variables || {},
    submission: runtime?.submission || null,
  };
}

export function buildRuntimeResponsePayload(
  requestId: string,
  ok: boolean,
  payload?: unknown,
  error?: string,
) {
  return {
    type: 'xrp-runtime-response',
    requestId,
    ok,
    payload: payload ?? null,
    error: error ? String(error) : null,
  };
}
