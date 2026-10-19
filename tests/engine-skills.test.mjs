import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/conversation/store.mjs';
import { Engine, dynamicTools } from '../src/work/engine.mjs';
import { SkillLibrary } from '../src/skills/skill-library.mjs';
import { LocalWorker } from '../src/runtime/local-worker.mjs';
import { VOICE_TOOLS } from '../src/voice/voice.mjs';
import { SKILL_SUPPORT_FILE_LIMIT } from '../src/skills/skill-limits.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-skill-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    worker = new EventEmitter();
  worker.status = 'online';
  worker.calls = [];
  worker.request = async (method, params) => {
    worker.calls.push({ method, params });
    if (method === 'skills/list')
      return { data: [{ cwd: params.cwds[0], skills: worker.skills.list(), errors: [] }] };
    return {};
  };
  const workspace = path.join(dir, 'workspaces', store.state.conversationId),
    skills = new SkillLibrary({ workspace }),
    engine = new Engine(store, worker, { skills });
  engine.active = { turnId: 'turn', startAcknowledged: true };
  return { dir, store, worker, engine, skills };
}

test('skill tools save actual Codex discoverable files, refresh discovery, and never claim helper execution', async (t) => {
  const { engine, worker, skills } = fixture(t),
    saved = await engine.tool('skill_save', {
      name: 'check-json',
      description: 'Check JSON files safely',
      instructions: 'Use python3 scripts/check.py for a JSON syntax check.',
      files: { 'scripts/check.py': 'import json,sys\njson.load(open(sys.argv[1]))\n' },
    });
  assert.equal(saved.saved, true);
  assert.equal(saved.helpersTested, false);
  assert.equal(saved.discovery.refreshed, true);
  assert.equal(saved.discovery.discovered, true);
  assert.equal(saved.discovery.errors, 0);
  assert.ok(fs.readFileSync(saved.skill.path, 'utf8').startsWith('---\nname: "check-json"'));
  assert.equal(
    saved.skill.path,
    path.join(engine.workspace, '.agents', 'skills', 'check-json', 'SKILL.md'),
  );
  assert.ok(fs.existsSync(path.join(path.dirname(saved.skill.path), 'scripts', 'check.py')));
  assert.equal(
    (await engine.tool('skill_get', { name: 'check-json' })).files['scripts/check.py'],
    saved.skill.files['scripts/check.py'],
  );
  assert.equal((await engine.tool('skill_list', {})).skills.length, 1);
  assert.deepEqual(worker.calls, [
    { method: 'skills/list', params: { cwds: [engine.workspace], forceReload: true } },
  ]);
  assert.equal(worker.skills, skills);
  for (const name of ['skill_list', 'skill_get', 'skill_save'])
    assert.ok(dynamicTools.some((tool) => tool.name === name));
  assert.match(engine.instructions(), /Run appropriate checks/);
  assert.match(engine.instructions(), /A reusable skill must be self-contained/);
  assert.match(engine.instructions(), /external workspace folder/);
  assert.match(
    dynamicTools.find((tool) => tool.name === 'skill_save').description,
    /supplying files replaces the entire supporting file map/,
  );
});

test('discovery failure does not misreport a durable saved skill or run arbitrary helper code', async (t) => {
  const { engine, worker } = fixture(t);
  worker.request = async () => {
    throw Error('Discovery unavailable');
  };
  const saved = await engine.tool('skill_save', {
    name: 'manual-check',
    description: 'Manual verification',
    instructions: 'Use the documented procedure.',
  });
  assert.equal(saved.saved, true);
  assert.equal(saved.discovery.refreshed, false);
  assert.ok(fs.existsSync(saved.skill.path));
  assert.equal(engine.loaded, false);
  const active = engine.active;
  engine.active = null;
  await assert.rejects(engine.tool('skill_list', {}), /accepted active task/);
  engine.active = active;
  await assert.rejects(
    engine.tool(
      'skill_get',
      { name: 'manual-check' },
      { owner: 'ended-call', isCurrent: () => false },
    ),
    /no longer belongs/,
  );
});

test('text and voice skill schemas admit complete thirty-file skills under the shared 128-file limit', async (t) => {
  const { engine } = fixture(t),
    files = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`scripts/check-${index}.py`, `print(${index})\n`]),
    );
  assert.equal(SKILL_SUPPORT_FILE_LIMIT, 128);
  assert.equal(
    dynamicTools.find((tool) => tool.name === 'skill_save').inputSchema.properties.files
      .maxProperties,
    SKILL_SUPPORT_FILE_LIMIT,
  );
  assert.equal(
    VOICE_TOOLS.find((tool) => tool.name === 'skill_save').parameters.properties.files
      .maxProperties,
    SKILL_SUPPORT_FILE_LIMIT,
  );
  const saved = await engine.tool('skill_save', {
    name: 'complete-skill',
    description: 'All supporting helpers.',
    instructions: 'Use the packaged helpers.',
    files,
  });
  assert.deepEqual(saved.skill.files, files);
  assert.deepEqual((await engine.tool('skill_get', { name: 'complete-skill' })).files, files);
});

test('LocalWorker passes the bridge token only through process environment and injects fresh skill indices', async (t) => {
  const { dir, store, skills } = fixture(t),
    home = path.join(dir, 'fake-home');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'codex'), 'not executed');
  const rpc = new EventEmitter(),
    calls = [],
    spawns = [];
  rpc.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };
  rpc.send = () => {};
  rpc.close = () => {};
  const worker = new LocalWorker(store, {
    platform: 'linux',
    home,
    verifyRuntime: async () => {},
    rpcFactory: (command, args, options) => {
      spawns.push({ command, args, options });
      return rpc;
    },
  });
  worker.workspaceRoot = path.join(home, 'workspaces');
  worker.skills = skills;
  worker.credentialBridgeToken = 'ephemeral-test-only';
  t.after(() => worker.disconnect());
  await worker.connect();
  assert.equal(spawns[0].options.env.DANT_CREDENTIAL_BRIDGE_TOKEN, 'ephemeral-test-only');
  assert.equal(spawns[0].args.join(' ').includes('ephemeral-test-only'), false);
  assert.ok(
    spawns[0].args.includes(
      'mcp_servers.dant_desktop.env_vars=' +
        JSON.stringify(['DANT_CREDENTIAL_BRIDGE_TOKEN', 'DANT_CONTROL_FILE']),
    ),
  );
  assert.ok(spawns[0].args.includes('mcp_servers.dant_desktop.tool_timeout_sec=660'));
  skills.save({
    name: 'known-skill',
    description: 'A reusable procedure',
    instructions: 'Use the known procedure.',
  });
  await worker.request('turn/start', {
    threadId: 'thread',
    input: [{ type: 'text', text: 'Do the work' }],
  });
  assert.ok(calls.at(-1).params.input.some((item) => item.text?.includes('known-skill')));
  await worker.request('thread/realtime/start', {
    threadId: 'thread',
    realtimeStartInstructions: 'Voice policy',
  });
  assert.match(calls.at(-1).params.realtimeStartInstructions, /known-skill/);
  const count = calls.length;
  skills.setEnabled('known-skill', false);
  assert.equal(calls.length, count);
  await worker.request('turn/steer', {
    threadId: 'thread',
    expectedTurnId: 'turn',
    input: [{ type: 'text', text: 'Continue' }],
  });
  assert.equal(
    calls.at(-1).params.input.some((item) => item.text?.includes('known-skill')),
    false,
  );
});
