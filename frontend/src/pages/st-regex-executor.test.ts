// Self-contained tests for st-regex-executor
// Run: npx tsx frontend/src/pages/st-regex-executor.test.ts

import { executeStRegexScripts, parseFindRegex, type RegexScript, type StRegexResult } from './st-regex-executor';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

function assertEq(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ──────────────────────────────────────────────
console.log('\n--- Test 1: Plain string findRegex ---');
{
  const card = {
    extensions: {
      regex_scripts: [
        { findRegex: 'Hello', replaceString: 'World', disabled: false },
      ] as RegexScript[],
    },
  };
  const result = executeStRegexScripts(card, 'Hello there');
  assertEq(result.matched, true, 'matched is true');
  assert(result.html.includes('World'), 'output contains "World"');
  assert(!result.html.includes('Hello'), 'output no longer contains "Hello"');
  assertEq(result.diagnostics.length, 0, 'no diagnostics');
}

// ──────────────────────────────────────────────
console.log('\n--- Test 2: /pattern/flags regex with group references ---');
{
  const card = {
    extensions: {
      regex_scripts: [
        { findRegex: '/(\\w+)@(\\w+)/g', replaceString: '$2@$1', disabled: false },
      ] as RegexScript[],
    },
  };
  const result = executeStRegexScripts(card, 'email: foo@bar');
  assertEq(result.matched, true, 'matched is true');
  assert(result.html.includes('bar@foo'), 'output contains swapped "bar@foo"');
  assertEq(result.diagnostics.length, 0, 'no diagnostics');
}

// ──────────────────────────────────────────────
console.log('\n--- Test 3: Disabled scripts are skipped ---');
{
  const card = {
    extensions: {
      regex_scripts: [
        { findRegex: 'Hello', replaceString: 'REPLACED', disabled: true },
        { findRegex: 'Hello', replaceString: 'World', disabled: false },
      ] as RegexScript[],
    },
  };
  const result = executeStRegexScripts(card, 'Hello there');
  assert(result.html.includes('World'), 'output contains "World" (second script)');
  assert(!result.html.includes('REPLACED'), 'output does not contain "REPLACED" (first was disabled)');
}

// ──────────────────────────────────────────────
console.log('\n--- Test 4: Invalid regex pattern produces diagnostics ---');
{
  const card = {
    extensions: {
      regex_scripts: [
        { findRegex: '/[invalid/g', replaceString: 'nope', disabled: false },
        { findRegex: 'ok', replaceString: 'good', disabled: false },
      ] as RegexScript[],
    },
  };
  const result = executeStRegexScripts(card, 'ok fine');
  assertEq(result.diagnostics.length, 1, 'one diagnostic');
  assertEq(result.diagnostics[0].level, 'warn', 'diagnostic level is warn');
  assert(result.html.includes('good'), 'valid script still ran');
}

// ──────────────────────────────────────────────
console.log('\n--- Test 5: Code fence stripping ---');
{
  const card = {
    extensions: {
      regex_scripts: [
        {
          findRegex: 'greeting',
          replaceString: '```html\n<div class="ui">Hello</div>\n```',
          disabled: false,
        },
      ] as RegexScript[],
    },
  };
  const result = executeStRegexScripts(card, 'greeting');
  assertEq(result.matched, true, 'matched');
  assert(result.html.includes('<div class="ui">Hello</div>'), 'code fences stripped');
  assert(!result.html.includes('```'), 'no backticks in output');
}

// ──────────────────────────────────────────────
console.log('\n--- Test 6: Complex HTML does not inject when findRegex misses ---');
{
  const bigHtml = '<style>' + 'x'.repeat(3100) + '</style>';
  const card = {
    extensions: {
      regex_scripts: [
        { findRegex: 'NEVER_MATCH_SENTINEL_XYZ', replaceString: bigHtml, disabled: false },
      ] as RegexScript[],
    },
  };
  const result = executeStRegexScripts(card, 'some content without the sentinel');
  assertEq(result.matched, false, 'matched is false when findRegex does not match');
  assertEq(result.html, '', 'output is empty when no script matched');
  assertEq(result.diagnostics[0]?.level, 'info', 'diagnostic explains skipped complex UI');
}

// ──────────────────────────────────────────────
console.log('\n--- Test 7: Macro substitution ---');
{
  const card = {
    extensions: {
      regex_scripts: [
        { findRegex: 'greet', replaceString: 'Hello {{user}}, I am {{char}}!', disabled: false },
      ] as RegexScript[],
    },
  };
  const result = executeStRegexScripts(card, 'greet', { userName: 'Alice', charName: 'Bob' });
  assert(result.html.includes('Alice'), '{{user}} replaced with Alice');
  assert(result.html.includes('Bob'), '{{char}} replaced with Bob');
  assert(!result.html.includes('{{user}}'), '{{user}} macro removed');
}

// ──────────────────────────────────────────────
console.log('\n--- Test 8: parseFindRegex helper ---');
{
  const re1 = parseFindRegex('/foo\\/bar/i');
  assert(re1 !== null, '/foo\\/bar/i parses successfully');
  assertEq(re1?.flags, 'gi', 'flags are "gi"');

  const re2 = parseFindRegex('literal [test]');
  assert(re2 !== null, 'literal string parses');
  assertEq(re2?.flags, 'g', 'literal gets global flag');
  assert(!re2?.test('a literal [test] here'), 'raw regex semantics do not treat [test] as literal text');

  const re3 = parseFindRegex('/[bad/');
  assertEq(re3, null, 'invalid regex returns null');

  const re4 = parseFindRegex('');
  assertEq(re4, null, 'empty string returns null');
}

// ──────────────────────────────────────────────
console.log('\n--- Test 9: SillyTavern escaped regex source ---');
{
  const card = {
    extensions: {
      regex_scripts: [
        { findRegex: '\\[开局\\]', replaceString: '<!doctype html><head></head><body><div id="app"></div></body>', disabled: false },
      ] as RegexScript[],
    },
  };
  const result = executeStRegexScripts(card, '[开局]');
  assertEq(result.matched, true, 'escaped regex source matches bracketed text');
  assert(!result.html.includes('[开局]'), 'trigger text is replaced');
  assert(result.html.includes('<div id="app"></div>'), 'replacement HTML is present');
}

// ──────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).process?.exit?.(1);
}
