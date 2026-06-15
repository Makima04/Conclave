import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ZOD_V4_COMPAT_SCRIPT } from './zod-compat-script';

test('ZOD_V4_COMPAT_SCRIPT adds v4-style prefault and z.z object helpers to Zod v3 UMD globals', () => {
  class ZodType {
    default(value: unknown) {
      return { kind: 'default', value, schema: this };
    }
  }
  class ZodString extends ZodType {}
  class ZodObject extends ZodType {
    passthrough() {
      return { kind: 'passthrough', schema: this };
    }
    strict() {
      return { kind: 'strict', schema: this };
    }
  }

  const zod = {
    ZodType,
    Schema: ZodType,
    ZodSchema: ZodType,
    string: () => new ZodString(),
    number: () => new ZodType(),
    boolean: () => new ZodType(),
    object: () => new ZodObject(),
    array: () => new ZodType(),
    record: () => new ZodType(),
    union: () => new ZodType(),
    coerce: { number: () => new ZodType() },
    preprocess: (fn: (value: unknown) => unknown, schema: unknown) => ({ kind: 'preprocess', fn, schema }),
  } as any;
  zod.z = Object.freeze({
    string: zod.string,
    object: zod.object,
  });

  const context = {
    window: { Zod: zod },
    Object,
  };

  vm.runInNewContext(ZOD_V4_COMPAT_SCRIPT, context);

  assert.equal(context.window.z, zod);
  assert.equal(zod.z, zod);
  assert.equal(typeof zod.looseObject, 'function');
  assert.equal(typeof zod.z.looseObject, 'function');

  const schema = zod.string();
  assert.equal(typeof schema.prefault, 'function');
  const prefaulted = schema.prefault('fallback');
  assert.equal(prefaulted.kind, 'preprocess');
  assert.equal(prefaulted.fn(undefined), 'fallback');
  assert.equal(prefaulted.fn('present'), 'present');
});
