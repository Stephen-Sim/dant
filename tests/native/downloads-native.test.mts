import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native attachment saves are main-window only and use a fixed authenticated loopback endpoint', () => {
  const rust = fs.readFileSync(
      new URL('../../src-tauri/src/downloads.rs', import.meta.url),
      'utf8',
    ),
    main = fs.readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(rust, /window\.label\(\) != "main"/);
  assert.match(rust, /valid_id\(&file_id\)/);
  assert.match(rust, /valid_token\(&token\)/);
  const command = rust.match(
    /#\[tauri::command\]\s*pub async fn save_attachment(?:<[^>]*>)?[\s\S]*?(?=\nasync fn save_attachment_using)/,
  )?.[0];
  assert.ok(command, 'the registered IPC command delegates to the native download boundary');
  assert.match(
    command,
    /save_attachment_using\([\s\S]*crate::protocol::controller_endpoint\(\),\s*tauri_plugin_dialog::FileDialogBuilder::blocking_save_file/,
  );
  assert.match(rust, /attachment_at\(endpoint, &file_id, &token\)\.await/);
  assert.match(rust, /async fn attachment_at\(/);
  assert.match(rust, /"http:\/\/\{endpoint\}\{\}\/files\/\{file_id\}\?download=1"/);
  assert.match(rust, /crate::protocol::api_prefix\(\)/);
  assert.match(rust, /header\("X-Dant-Token", token\)/);
  assert.match(rust, /no_proxy\(\)\s*\.redirect\(reqwest::redirect::Policy::none\(\)\)/);
  assert.match(rust, /MAX_BYTES: usize = crate::protocol::ATTACHMENT_MAX_BYTES/);
  assert.doesNotMatch(
    rust,
    /pub\s+async\s+fn\s+save_attachment(?:<[^>]*>)?\s*\([^)]*\b(?:url|endpoint|destination|path)\s*:/,
  );
  assert.match(main, /downloads::save_attachment/);
  assert.match(main, /plugin\(tauri_plugin_dialog::init\(\)\)/);
});

test('Save As and atomic writing run off the UI thread without granting general renderer filesystem access', () => {
  const rust = fs.readFileSync(
      new URL('../../src-tauri/src/downloads.rs', import.meta.url),
      'utf8',
    ),
    cap = JSON.parse(
      fs.readFileSync(
        new URL('../../src-tauri/capabilities/default.json', import.meta.url),
        'utf8',
      ),
    ),
    overlay = JSON.parse(
      fs.readFileSync(
        new URL('../../src-tauri/capabilities/call-overlay.json', import.meta.url),
        'utf8',
      ),
    ),
    atomic = fs.readFileSync(
      new URL('../../src-tauri/src/atomic_file.rs', import.meta.url),
      'utf8',
    );
  assert.match(rust, /spawn_blocking\(move \|\|/);
  assert.match(
    rust,
    /choose\(app\.dialog\(\)\.file\(\)\.set_parent\(&window\)\.set_file_name\(&name\)\)/,
  );
  assert.match(rust, /let Some\(chosen\) = chosen else\s*\{\s*return Ok\(false\);?\s*\}/);
  assert.match(rust, /tempfile_in\(parent\)/);
  assert.match(
    rust,
    /crate::atomic_file::publish\(\s*temporary,\s*destination,\s*crate::atomic_file::FlushPolicy::BeforeSync/,
  );
  assert.match(atomic, /self\.persist\(destination\)/);
  assert.match(atomic, /self\.as_file\(\)\.sync_all\(\)/);
  assert.match(
    atomic,
    /output\.flush\(\)[\s\S]*output\.sync_all\(\)[\s\S]*before_commit\(\)[\s\S]*output\s*\.commit\(destination\)/,
  );
  assert.equal(
    [...cap.permissions, ...overlay.permissions].some((value) => /^(fs|dialog):/.test(value)),
    false,
  );
});
