import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeStRegexScripts,
  parseFindRegex,
  type RegexScript,
} from './st-regex-executor.ts';

function buildCard(regexScripts: RegexScript[]) {
  return {
    extensions: {
      regex_scripts: regexScripts,
    },
  };
}

test('plain string findRegex replaces matching content', () => {
  const result = executeStRegexScripts(
    buildCard([{ findRegex: 'Hello', replaceString: 'World', disabled: false }]),
    'Hello there',
  );

  assert.equal(result.matched, true);
  assert.match(result.html, /World/);
  assert.doesNotMatch(result.html, /Hello/);
  assert.equal(result.diagnostics.length, 0);
});

test('regex replacements expand capture groups', () => {
  const result = executeStRegexScripts(
    buildCard([{ findRegex: '/(\\w+)@(\\w+)/g', replaceString: '$2@$1', disabled: false }]),
    'email: foo@bar',
  );

  assert.equal(result.matched, true);
  assert.match(result.html, /bar@foo/);
  assert.equal(result.diagnostics.length, 0);
});

test('disabled scripts are skipped', () => {
  const result = executeStRegexScripts(
    buildCard([
      { findRegex: 'Hello', replaceString: 'REPLACED', disabled: true },
      { findRegex: 'Hello', replaceString: 'World', disabled: false },
    ]),
    'Hello there',
  );

  assert.match(result.html, /World/);
  assert.doesNotMatch(result.html, /REPLACED/);
});

test('invalid regex patterns produce diagnostics without blocking valid scripts', () => {
  const result = executeStRegexScripts(
    buildCard([
      { findRegex: '/[invalid/g', replaceString: 'nope', disabled: false },
      { findRegex: 'ok', replaceString: 'good', disabled: false },
    ]),
    'ok fine',
  );

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.level, 'warn');
  assert.match(result.html, /good/);
});

test('replacement code fences are stripped', () => {
  const result = executeStRegexScripts(
    buildCard([
      {
        findRegex: 'greeting',
        replaceString: '```html\n<div class="ui">Hello</div>\n```',
        disabled: false,
      },
    ]),
    'greeting',
  );

  assert.equal(result.matched, true);
  assert.match(result.html, /<div class="ui">Hello<\/div>/);
  assert.doesNotMatch(result.html, /```/);
});

test('complex HTML replacements stay inactive when the trigger misses', () => {
  const bigHtml = `<style>${'x'.repeat(3100)}</style>`;
  const result = executeStRegexScripts(
    buildCard([{ findRegex: 'NEVER_MATCH_SENTINEL_XYZ', replaceString: bigHtml, disabled: false }]),
    'some content without the sentinel',
  );

  assert.equal(result.matched, false);
  assert.equal(result.html, '');
  assert.equal(result.diagnostics[0]?.level, 'info');
});

test('SillyTavern macros are substituted in replacements', () => {
  const result = executeStRegexScripts(
    buildCard([{ findRegex: 'greet', replaceString: 'Hello {{user}}, I am {{char}}!', disabled: false }]),
    'greet',
    { userName: 'Alice', charName: 'Bob' },
  );

  assert.match(result.html, /Alice/);
  assert.match(result.html, /Bob/);
  assert.doesNotMatch(result.html, /\{\{user\}\}/);
});

test('parseFindRegex mirrors current string and regex semantics', () => {
  const slashRegex = parseFindRegex('/foo\\/bar/i');
  assert.ok(slashRegex);
  assert.equal(slashRegex.flags, 'i');

  const rawRegex = parseFindRegex('literal [test]');
  assert.ok(rawRegex);
  assert.equal(rawRegex.flags, '');
  assert.equal(rawRegex.test('a literal [test] here'), false);

  assert.equal(parseFindRegex('/[bad/'), null);
  assert.equal(parseFindRegex(''), null);
});

test('escaped ST-style bracketed triggers match correctly', () => {
  const result = executeStRegexScripts(
    buildCard([
      {
        findRegex: '\\[开局\\]',
        replaceString: '<!doctype html><head></head><body><div id="app"></div></body>',
        disabled: false,
      },
    ]),
    '[开局]',
  );

  assert.equal(result.matched, true);
  assert.doesNotMatch(result.html, /\[开局\]/);
  assert.match(result.html, /<div id="app"><\/div>/);
});

test('replacement text preserves dollar-backtick sequences used in embedded scripts', () => {
  const replacement = String.raw`<script>const re = new RegExp(\`<${'${tag}'}\\b[^>]*>([\\s\\S]*)$\`, 'i');</script>`;
  const result = executeStRegexScripts(
    buildCard([{ findRegex: '\\[开局\\]', replaceString: replacement, disabled: false }]),
    '[开局]',
  );

  assert.equal(result.matched, true);
  assert.match(result.html, /new RegExp/);
  assert.ok(result.html.includes('*)$`') || result.html.includes('*)$\\`'));
});
