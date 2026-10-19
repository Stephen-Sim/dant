import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native attachment saves are main-window only and use a fixed authenticated loopback endpoint', () => {
  const rust = fs.readFileSync(new URL('../src-tauri/src/downloads.rs', import.meta.url), 'utf8'),
    main = fs.readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(rust, /window\.label\(\) != "main"/);
  assert.match(rust, /valid_id\(&file_id\)/);
  assert.match(rust, /valid_token\(&token\)/);
  assert.match(rust, /http:\/\/127\.0\.0\.1:4317\/api\/files\/\{file_id\}\?download=1/);
  assert.match(rust, /header\("X-Dant-Token", token\)/);
  assert.match(rust, /no_proxy\(\)\s*\.redirect\(reqwest::redirect::Policy::none\(\)\)/);
  assert.match(rust, /MAX_BYTES: usize = 10 \* 1024 \* 1024/);
  assert.doesNotMatch(
    rust,
    /pub\s+async\s+fn\s+save_attachment\s*\([^)]*\b(?:url|destination|path)\s*:/,
  );
  assert.match(main, /downloads::save_attachment/);
  assert.match(main, /plugin\(tauri_plugin_dialog::init\(\)\)/);
});

test('Save As and atomic writing run off the UI thread without granting general renderer filesystem access', () => {
  const rust = fs.readFileSync(new URL('../src-tauri/src/downloads.rs', import.meta.url), 'utf8'),
    cap = JSON.parse(
      fs.readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
    ),
    overlay = JSON.parse(
      fs.readFileSync(
        new URL('../src-tauri/capabilities/call-overlay.json', import.meta.url),
        'utf8',
      ),
    );
  assert.match(rust, /spawn_blocking\(move \|\|/);
  assert.match(rust, /set_parent\(&window\)\s*\.set_file_name\(&name\)\s*\.blocking_save_file\(\)/);
  assert.match(rust, /let Some\(chosen\) = chosen else\s*\{\s*return Ok\(false\);?\s*\}/);
  assert.match(rust, /tempfile_in\(parent\)/);
  assert.match(rust, /temporary\.persist\(destination\)/);
  assert.match(rust, /sync_all\(\)/);
  assert.equal(
    [...cap.permissions, ...overlay.permissions].some((value) => /^(fs|dialog):/.test(value)),
    false,
  );
});
