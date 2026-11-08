import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { q, qpath } from '../src/transport/ssh.ts';
import { clean, detectStatus, menuKeys, summarize, tail } from '../src/summarize.ts';
import { statusFor } from '../src/tools/events.ts';
import { parseKv } from '../src/tools/machines.ts';
import { findProject, loadConfig } from '../src/config.ts';

test('q() survives quotes and shell metacharacters', () => {
  const nasty = `it's "x" $(rm -rf /) \`id\` ; | &`;
  assert.equal(execFileSync('sh', ['-c', `printf %s ${q(nasty)}`]).toString(), nasty);
  assert.equal(execFileSync('sh', ['-c', `printf %s ${qpath("~/a b'c")}`]).toString(), `${process.env.HOME}/a b'c`);
});

const PANE = `\x1b[32m⏺ Update(src/app.ts)\x1b[0m
  12 + const a = 1;
⏺ Write(src/new.ts)
⏺ Bash(npm test)
  Error: 2 tests failed
╭──────────────╮
│ Bash command  │
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No`;

test('summarize/detectStatus read a permission prompt', () => {
  assert.equal(detectStatus(PANE), 'waiting_approval');
  assert.equal(detectStatus('✻ Thinking… (esc to interrupt)'), 'working');
  assert.equal(detectStatus('> '), undefined);
  const s = summarize(PANE);
  assert.equal(s.changed_files_count, 2);
  assert.equal(s.last_action, 'Bash(npm test)');
  assert.match(s.last_error!, /2 tests failed/);
  assert.match(s.waiting_for!, /Do you want to proceed/);
  assert.ok(!clean(PANE).some((l) => l.includes('\x1b')));
});

// Captured from Claude Code 2.1.319 on the first start with a brain import.
const IMPORT_DIALOG = `  Allow external CLAUDE.md file imports?
  This project's CLAUDE.md or .claude/rules imports files outside the current
  working directory. Never allow this for third-party repositories.
  External imports:
    /home/user/brain/projects/orchestrator/context.md
  Important: Only use Claude Code with files you trust. Accessing untrusted
  files may pose security risks https://code.claude.com/docs/en/security
  ❯ No, disable external imports
    Yes, allow external imports
  Enter to confirm · Esc to cancel`;

test('menuKeys picks the right option in numbered and unnumbered menus', () => {
  assert.equal(detectStatus(IMPORT_DIALOG), 'waiting_approval');
  assert.deepEqual(menuKeys(IMPORT_DIALOG, 'yes'), ['Down', 'Enter']);
  assert.deepEqual(menuKeys(IMPORT_DIALOG, 'always'), ['Down', 'Enter']);
  assert.deepEqual(menuKeys(IMPORT_DIALOG, 'no'), ['Enter']);
  assert.deepEqual(menuKeys(PANE, 'yes'), ['1']);
  assert.deepEqual(menuKeys(PANE, 'always'), ['2']);
  assert.deepEqual(menuKeys(PANE, 'no'), ['3']);
  assert.equal(menuKeys('plain output', 'yes'), null);
});

test('tail collapses long diffs', () => {
  const diff = Array.from({ length: 20 }, (_, i) => `  ${i} + line`).join('\n');
  const t = tail(diff, 100);
  assert.equal(t.split('\n').length, 6);
  assert.match(t, /diff truncated/);
});

test('hook payload → status', () => {
  assert.equal(statusFor({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), 'waiting_approval');
  assert.equal(statusFor({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }), 'waiting_input');
  assert.equal(statusFor({ hook_event_name: 'Stop' }), 'idle');
  assert.equal(statusFor({ hook_event_name: 'PreToolUse' }), undefined);
});

test('parseKv reads machine_status output', () => {
  const o = parseKv('cpus=8\nload=0.52\ndisk_pct=41%\ngpu=RTX 3070, 12, 2048, 8192\nlink=ethernet');
  assert.deepEqual(o, { cpus: 8, load: 0.52, disk_pct: '41%', link: 'ethernet', gpus: [{ name: 'RTX 3070', util_pct: 12, vram_used_mb: 2048, vram_total_mb: 8192 }] });
});

test('config validates machines and resolves aliases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  writeFileSync(join(dir, 'machines.yaml'), 'machines:\n  - {id: node2, local: true}\n');
  writeFileSync(join(dir, 'projects.yaml'), 'projects:\n  - {id: myapp, aliases: [My App], machine: node2}\n');
  const cfg = loadConfig(dir);
  assert.equal(findProject(cfg, 'my app').id, 'myapp');
  writeFileSync(join(dir, 'projects.yaml'), 'projects:\n  - {id: x, machine: nope}\n');
  assert.throws(() => loadConfig(dir), /unknown machine/);
  writeFileSync(join(dir, 'machines.yaml'), 'machines:\n  - {id: gpu}\n');
  assert.throws(() => loadConfig(dir), /ssh_host/);
});

test('real Claude Code 2.1.319 idle pane: statusline is not an action', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('./fixtures/idle-2.1.319.txt', import.meta.url), 'utf8');
  assert.equal(summarize(raw).last_action, 'OK');
  assert.equal(detectStatus(raw), undefined);
});
