export const ZOD_V4_COMPAT_SCRIPT = `
(() => {
  const root = window.Zod || window.z;
  if (!root) return;

  window.Zod = root;
  window.z = root;

  try {
    root.z = root;
    root.default = root;
  } catch (_) {}

  const createPrefault = namespace => function(defaultValue) {
    const resolveDefault = () => typeof defaultValue === 'function' ? defaultValue() : defaultValue;
    if (typeof namespace?.preprocess === 'function') {
      return namespace.preprocess(
        value => value === undefined ? resolveDefault() : value,
        this,
      );
    }
    if (typeof this?.default === 'function') {
      return this.default(resolveDefault());
    }
    return this;
  };

  const patchPrefaultPrototype = (prototype, namespace) => {
    if (!prototype || prototype === Object.prototype) return;
    if (typeof prototype.prefault !== 'function') {
      try {
        Object.defineProperty(prototype, 'prefault', {
          value: createPrefault(namespace),
          configurable: true,
          writable: true,
        });
      } catch (_) {
        prototype.prefault = createPrefault(namespace);
      }
    }
  };

  const patchSchemaPrototype = (schema, namespace) => {
    let prototype = schema && Object.getPrototypeOf(schema);
    while (prototype && prototype !== Object.prototype) {
      patchPrefaultPrototype(prototype, namespace);
      prototype = Object.getPrototypeOf(prototype);
    }
  };

  const patchNamespace = namespace => {
    if (!namespace || typeof namespace.object !== 'function') return;

    if (typeof namespace.looseObject !== 'function') {
      namespace.looseObject = (shape, params) => namespace.object(shape, params).passthrough();
    }
    if (typeof namespace.strictObject !== 'function') {
      namespace.strictObject = (shape, params) => namespace.object(shape, params).strict();
    }

    patchPrefaultPrototype(namespace.ZodType?.prototype, namespace);
    patchPrefaultPrototype(namespace.Schema?.prototype, namespace);
    patchPrefaultPrototype(namespace.ZodSchema?.prototype, namespace);

    const sampleFactories = [
      () => namespace.string?.(),
      () => namespace.number?.(),
      () => namespace.boolean?.(),
      () => namespace.object?.({}),
      () => namespace.array?.(namespace.string?.()),
      () => namespace.record?.(namespace.string?.()),
      () => namespace.union?.([namespace.string?.(), namespace.number?.()]),
      () => namespace.coerce?.number?.(),
    ];

    for (const factory of sampleFactories) {
      try {
        const schema = factory();
        if (schema) patchSchemaPrototype(schema, namespace);
      } catch (_) {}
    }
  };

  patchNamespace(root);
  patchNamespace(root.z);
})();
`;
