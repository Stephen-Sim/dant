import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  collectCoverageInventory,
  coverageInventoryMarkdown,
  type CoverageInput,
} from '../../../scripts/ci/coverage-inventory.mts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-coverage-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trackedFiles: string[] = [];
  const write = (file: string, content = 'fixture source\n') => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    if (!trackedFiles.includes(file)) trackedFiles.push(file);
    return target;
  };
  return { root, trackedFiles, write };
}
const input = (content: string, file = 'synthetic-report'): CoverageInput => ({ content, file });
const lcov = (file: string, covered = 1, total = 2) =>
  `SF:${file}\nLF:${total}\nLH:${covered}\nBRF:2\nBRH:1\nFNF:1\nFNH:1\nend_of_record\n`;
const goLine = (file: string, hits: number, total = 3) =>
  `github.com/Stephen-Sim/dant/core/${file}:1.1,2.2 ${total} ${hits}\n`;
const rust = (file: string) =>
  JSON.stringify({
    data: [
      {
        files: [
          {
            filename: file,
            summary: {
              lines: { count: 10, covered: 8 },
              functions: { count: 3, covered: 2 },
              regions: { count: 12, covered: 9 },
            },
          },
        ],
      },
    ],
  });
const python = (file: string) =>
  JSON.stringify({
    meta: { branch_coverage: true },
    files: {
      [file]: {
        summary: { num_statements: 8, covered_lines: 7, num_branches: 4, covered_branches: 2 },
      },
    },
  });

test('embedded C# remains explicitly unmeasured even when every surrounding PowerShell command ran', (t) => {
  const f = fixture(t),
    body = 'public static class Fixture { public static int Value() { return 1; } }\n',
    text = "function Read-Fixture {\n    Add-Type -TypeDefinition @'\n" + body + "'@\n}\n";
  f.write('native/adapter.ps1', text);
  const report = collectCoverageInventory({
    ...f,
    platform: 'win32',
    source: { commit: 'a'.repeat(40), dirty: false },
    reports: {
      powershell: input(
        JSON.stringify({
          metric: 'PowerShell executable commands',
          tool: 'Pester 5.9.0',
          platform: 'Win32NT',
          covered: 1,
          total: 1,
          files: [{ file: 'native/adapter.ps1', covered: 1, total: 1, missingLines: [] }],
        }),
      ),
    },
  });
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0]?.metrics?.commands?.percent, 100);
  assert.equal(report.embeddedScopes.length, 1);
  const scope = report.embeddedScopes[0];
  assert.deepEqual(scope, {
    sourceFile: 'native/adapter.ps1',
    startLine: 2,
    endLine: 4,
    language: 'C#',
    status: 'not-measured',
    reason:
      'Pester measures PowerShell commands, not the embedded CLR body. No C# instrumentation report is available.',
    sourceSHA256: createHash('sha256').update(text).digest('hex'),
    bodySHA256: createHash('sha256').update(body).digest('hex'),
  });
  assert.equal(report.sourceCommit, 'a'.repeat(40));
  const markdown = coverageInventoryMarkdown(report);
  assert.match(markdown, /Embedded source outside instrumentation/);
  assert.match(markdown, /\[native\/adapter\.ps1:2\]\(native\/adapter\.ps1#L2\)/);
  assert.match(markdown, /C#: not-measured/);
  assert.ok(markdown.includes(scope?.bodySHA256 ?? 'missing'));
  assert.deepEqual(report.failures, []);
});

test('embedded detection skips comments, data here-strings, quoted examples and bare command arguments', (t) => {
  const f = fixture(t);
  f.write(
    'scripts/example.ps1',
    [
      "# Add-Type -TypeDefinition @' not executable",
      "<# nested comment <# Add-Type -TypeDefinition @' #> #>",
      '$example = "Add-Type -TypeDefinition sample"',
      "$text = @'",
      'Add-Type -TypeDefinition @"',
      'class Example {}',
      '"@',
      "'@",
      "Write-Output Add-Type -TypeDefinition @'",
      'class Argument {}',
      "'@",
      'Add-Type -AssemblyName System.Runtime',
    ].join('\n'),
  );
  const report = collectCoverageInventory({ ...f, reports: {} });
  assert.deepEqual(report.embeddedScopes, []);
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0]?.status, 'not-measured');
});

test('new definitions beyond the old header window and continued module-qualified commands are inventoried', (t) => {
  const f = fixture(t),
    first = 'public class First {}\n',
    second = 'public class Second {}\n';
  f.write(
    'scripts/adapters.ps1',
    '# padding '.repeat(600) +
      '\n' +
      [
        "& 'Microsoft.PowerShell.Utility\\Add-Type' `",
        "  -TypeDefinition @'",
        first.trimEnd(),
        "'@ -Language CSharp",
        'Add`-Type -Language "CSharp" -TypeDefinition @"',
        second.trimEnd(),
        '"@',
      ].join('\n'),
  );
  const report = collectCoverageInventory({ ...f, platform: 'linux', reports: {} });
  assert.equal(report.files.length, 1);
  assert.equal(report.embeddedScopes.length, 2);
  assert.deepEqual(
    report.embeddedScopes.map((item) => item.bodySHA256),
    [first, second].map((body) => createHash('sha256').update(body).digest('hex')),
  );
  assert.ok(
    report.embeddedScopes.every(
      (scope) => scope.status === 'not-measured' && scope.language === 'C#',
    ),
  );
  assert.equal(report.languages.find((item) => item.language === 'PowerShell')?.files, 1);
});

test('ambiguous definitions and malformed or oversized PowerShell cannot silently lose embedded source', (t) => {
  const f = fixture(t);
  for (const text of [
    "Add-Type -TypeDefinition @'\nclass Unfinished {}\n",
    'Add-Type -TypeDefinition $unknownSource\n',
    'Add-Type -TypeDefinition @"\nclass WrongLanguage {}\n"@ -Language VisualBasic\n',
    '"$(Add-Type -TypeDefinition $nestedSource)"\n',
    '<# unfinished comment',
    "'unfinished string",
    '#'.repeat(1024 * 1024 + 1),
  ]) {
    f.write('scripts/unsafe.ps1', text);
    assert.throws(() => collectCoverageInventory({ ...f, reports: {} }), /invalid/);
  }
  f.write('scripts/unsafe.ps1', "Add-Type -TypeDefinition @'\nclass Before {}\n'@\n");
  const before = collectCoverageInventory({ ...f, reports: {} }).embeddedScopes[0];
  f.write('scripts/unsafe.ps1', "Add-Type -TypeDefinition @'\nclass After {}\n'@\n");
  const after = collectCoverageInventory({ ...f, reports: {} }).embeddedScopes[0];
  assert.notEqual(before?.sourceSHA256, after?.sourceSHA256);
  assert.notEqual(before?.bodySHA256, after?.bodySHA256);
});

test('per-file inventory keeps real language counts separate and never credits unmeasured shell scripts', (t) => {
  const f = fixture(t);
  for (const name of [
    'ui/chat/render.mts',
    'scripts/build.mts',
    'core/internal/work/work.go',
    'src-tauri/src/main.rs',
    'vm/guest.py',
    'native/speech.ps1',
    'vm/bootstrap.sh',
    'vite.config.mts',
  ])
    f.write(name);
  const report = collectCoverageInventory({
    ...f,
    platform: 'win32',
    reports: {
      typescript: input(lcov('ui/chat/render.mts') + lcov('scripts/build.mts', 0, 4)),
      go: input(
        'mode: atomic\n' + goLine('internal/work/work.go', 0) + goLine('internal/work/work.go', 2),
      ),
      rust: input(rust(path.join(f.root, 'src-tauri/src/main.rs'))),
      python: input(python('vm/guest.py')),
    },
  });
  assert.equal(report.files.length, 8);
  assert.deepEqual(report.files.find((item) => item.language === 'Go')?.metrics?.statements, {
    covered: 3,
    total: 3,
    percent: 100,
  });
  assert.equal(
    report.files.find((item) => item.file === 'scripts/build.mts')?.metrics?.lines?.percent,
    0,
  );
  assert.equal(
    report.files.find((item) => item.file === 'vite.config.mts')?.status,
    'not-measured',
  );
  for (const language of ['PowerShell', 'Bash']) {
    const item = report.files.find((file) => file.language === language);
    assert.equal(item?.status, 'not-measured');
    assert.equal(item?.metrics, undefined);
    assert.match(
      item?.reason ?? '',
      language === 'Bash' ? /kcov Linux shell collector was not measured/ : /No matching file/,
    );
  }
  const typescript = report.languages.find((item) => item.language === 'TypeScript');
  assert.equal(typescript?.unmeasured, 1);
  assert.equal(typescript?.metrics.lines?.covered, 1);
  assert.equal(typescript?.metrics.lines?.total, 6);
  assert.ok(Math.abs((typescript?.metrics.lines?.percent ?? 0) - 100 / 6) < 1e-10);
  assert.deepEqual(report.failures, []);
});

test('declarations/static/dependency/tests are explicit exclusions while generated executable source remains', (t) => {
  const f = fixture(t);
  for (const name of [
    'ui/shared/types.d.ts',
    'ui/style.css',
    'ui/index.html',
    'resources/settings.json',
    'core/vendor/example/helper.go',
    'scripts/a.test.mts',
    'tests/vm/test_guest.py',
  ])
    f.write(name);
  f.write(
    'core/internal/contracts/states.go',
    '// Code generated. DO NOT EDIT.\nfunc Valid() bool {return true}\n',
  );
  const report = collectCoverageInventory({ ...f, reports: {} });
  assert.deepEqual(
    report.files.map((item) => item.file),
    ['core/internal/contracts/states.go'],
  );
  assert.equal(report.files[0]?.generated, true);
  assert.equal(report.files[0]?.status, 'not-measured');
  assert.equal(report.excluded.length, 7);
  assert.equal(
    report.excluded.find((item) => item.file.endsWith('.d.ts'))?.reason,
    'type-declaration',
  );
});

test('missing reports, zero-unit reports and actual zero hits have different honest results', (t) => {
  const f = fixture(t);
  f.write('scripts/pure-types.ts');
  f.write('scripts/not-loaded.mts');
  f.write('scripts/no-report.mts');
  const report = collectCoverageInventory({
    ...f,
    reports: {
      typescript: input(
        lcov('scripts/pure-types.ts', 0, 0).replace(/(BRF|BRH|FNF|FNH):[0-9]+/g, '$1:0') +
          lcov('scripts/not-loaded.mts', 0, 3),
      ),
    },
  });
  assert.match(
    report.files.find((item) => item.file.endsWith('pure-types.ts'))?.reason ?? '',
    /no executable units/,
  );
  assert.equal(
    report.files.find((item) => item.file.endsWith('no-report.mts'))?.metrics,
    undefined,
  );
  assert.equal(
    report.files.find((item) => item.file.endsWith('not-loaded.mts'))?.metrics?.lines?.percent,
    0,
  );
  assert.equal(report.reports.find((item) => item.collector === 'go')?.status, 'missing');
});

test('malformed reports and impossible counts credit no partial file measurements', (t) => {
  const f = fixture(t);
  f.write('scripts/build.mts');
  for (const content of [
    lcov('scripts/build.mts', 3, 2),
    lcov('scripts/build.mts') + lcov('scripts/build.mts'),
    'invalid',
  ]) {
    const report = collectCoverageInventory({ ...f, reports: { typescript: input(content) } });
    assert.equal(report.reports[0]?.status, 'invalid');
    assert.equal(report.failures.length, 1);
    assert.equal(report.files[0]?.status, 'not-measured');
  }
});

test('Go duplicate blocks are unioned, and conflicting weights or invalid coordinates fail', (t) => {
  const f = fixture(t);
  f.write('core/internal/work/work.go');
  for (const content of [
    'mode: atomic\n' + goLine('internal/work/work.go', 0) + goLine('internal/work/work.go', 1, 4),
    'mode: atomic\n' + goLine('internal/work/work.go', 1).replace(':1.1,2.2', ':0.1,2.2'),
  ]) {
    const report = collectCoverageInventory({ ...f, reports: { go: input(content) } });
    assert.equal(report.reports.find((item) => item.collector === 'go')?.status, 'invalid');
    assert.equal(report.files[0]?.metrics, undefined);
  }
});

test('Python line-only reports cannot impersonate branch-enabled helper coverage', (t) => {
  const f = fixture(t);
  f.write('vm/guest.py');
  const report = collectCoverageInventory({
    ...f,
    reports: { python: input(python('vm/guest.py').replace('true', 'false')) },
  });
  assert.equal(report.reports.find((item) => item.collector === 'python')?.status, 'invalid');
  assert.equal(report.files[0]?.status, 'not-measured');
});

test('Windows/Linux-specific sources have visible platform reasons rather than exclusion', (t) => {
  const f = fixture(t);
  f.write('core/internal/platform/disk_windows.go');
  f.write('core/internal/platform/disk_linux.go');
  f.write('core/internal/platform/disk_other.go', '//go:build !windows\npackage platform\n');
  const linux = collectCoverageInventory({ ...f, platform: 'linux', reports: {} });
  assert.match(
    linux.files.find((item) => item.file.endsWith('_windows.go'))?.reason ?? '',
    /windows-specific/,
  );
  const windows = collectCoverageInventory({ ...f, platform: 'win32', reports: {} });
  assert.match(
    windows.files.find((item) => item.file.endsWith('_linux.go'))?.reason ?? '',
    /linux-specific/,
  );
  assert.match(
    windows.files.find((item) => item.file.endsWith('_other.go'))?.reason ?? '',
    /Non-Windows/,
  );
  assert.equal(windows.files.length, 3);
});

test('a source modified after the supplied report is not silently credited as current', (t) => {
  const f = fixture(t);
  const file = f.write('scripts/build.mts');
  const report = collectCoverageInventory({
    ...f,
    reports: {
      typescript: {
        ...input(lcov('scripts/build.mts', 2, 2)),
        modifiedMs: fs.statSync(file).mtimeMs - 100,
      },
    },
  });
  assert.equal(report.files[0]?.status, 'not-measured');
  assert.match(report.files[0]?.reason ?? '', /Source changed/);
  assert.equal(report.languages[0]?.metrics.lines, undefined);
});

test('inventory discovery includes new untracked maintained files without scanning ignored runtime data', (t) => {
  const f = fixture(t);
  f.write('scripts/new-tool.mts');
  f.write('.gitignore', '.cache/\n');
  f.write('.cache/private.py', 'must never be included');
  execFileSync('git', ['init', '--quiet'], { cwd: f.root, stdio: 'ignore' });
  const report = collectCoverageInventory({ root: f.root, reports: {} });
  assert.deepEqual(
    report.files.map((item) => item.file),
    ['scripts/new-tool.mts'],
  );
  assert.equal(
    report.excluded.some((item) => item.file.startsWith('.cache')),
    false,
  );
});

test('unsafe source paths and linked source files are rejected before reading outside the repository', (t) => {
  const f = fixture(t);
  const file = f.write('scripts/build.mts');
  for (const name of [
    '../private.py',
    '/absolute.py',
    'scripts/../private.py',
    'scripts/a|b.mts',
  ]) {
    assert.throws(
      () => collectCoverageInventory({ root: f.root, trackedFiles: [name], reports: {} }),
      /invalid/,
    );
  }
  fs.linkSync(file, path.join(f.root, 'scripts/linked.mts'));
  assert.throws(() => collectCoverageInventory({ ...f, reports: {} }), /invalid/);
});

test('summary links real report sections, exposes every unmeasured source and does not average languages', (t) => {
  const f = fixture(t);
  f.write('vm/bootstrap.sh');
  const report = collectCoverageInventory({
    ...f,
    reports: {},
    reportLinks: { go: '#go-core-statement-coverage' },
  });
  const markdown = coverageInventoryMarkdown(report);
  assert.match(markdown, /\[go\]\(#go-core-statement-coverage\)/);
  assert.match(markdown, /vm\/bootstrap.sh/);
  assert.match(markdown, /unknown denominators/);
  assert.doesNotMatch(markdown, /Overall.*100%/);
  assert.throws(
    () =>
      collectCoverageInventory({ ...f, reports: {}, reportLinks: { go: 'javascript:alert(1)' } }),
    /invalid/,
  );
});

test('Linux Bash measurements retain real zero-hit scripts separately from embedded Python coverage', (t) => {
  const f = fixture(t);
  f.write('vm/bootstrap.sh');
  f.write('vm/start-codex.sh');
  const report = collectCoverageInventory({
    ...f,
    platform: 'linux',
    reports: {
      bash: input(
        JSON.stringify({
          tool: 'kcov 43',
          covered: 1,
          total: 10,
          files: [
            { file: 'vm/bootstrap.sh', covered: 0, total: 9 },
            { file: 'vm/start-codex.sh', covered: 1, total: 1 },
          ],
        }),
      ),
    },
  });
  assert.equal(report.languages.find((item) => item.language === 'Bash')?.measured, 2);
  assert.deepEqual(report.languages.find((item) => item.language === 'Bash')?.metrics.lines, {
    covered: 1,
    total: 10,
    percent: 10,
  });
  assert.deepEqual(report.files.find((item) => item.file === 'vm/bootstrap.sh')?.metrics?.lines, {
    covered: 0,
    total: 9,
    percent: 0,
  });
  assert.equal(report.failures.length, 0);
  assert.match(coverageInventoryMarkdown(report), /\[bash\]\(#bash-shell-coverage\)/);
});

test('source identity, report SHA and exact zero counts are retained without mutating injected input', (t) => {
  const f = fixture(t);
  f.write('scripts/build.mts');
  const content = lcov('scripts/build.mts', 0, 2);
  const reports = Object.freeze({ typescript: Object.freeze(input(content)) });
  const report = collectCoverageInventory({
    ...f,
    reports,
    source: { commit: 'a'.repeat(40), dirty: true },
  });
  assert.equal(report.sourceCommit, 'a'.repeat(40));
  assert.equal(report.sourceDirty, true);
  assert.equal(report.reports[0]?.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(report.files[0]?.metrics?.lines?.percent, 0);
  assert.throws(
    () => collectCoverageInventory({ ...f, reports, source: { commit: 'invalid', dirty: false } }),
    /invalid/,
  );
});

test('duplicate Rust file summaries and invalid JSON cannot over-credit native measurements', (t) => {
  const f = fixture(t);
  f.write('src-tauri/src/main.rs');
  const original: unknown = JSON.parse(rust('src-tauri/src/main.rs'));
  assert.ok(
    original && typeof original === 'object' && 'data' in original && Array.isArray(original.data),
  );
  const content = JSON.stringify({ data: [...original.data, ...original.data] });
  for (const value of [content, '{invalid', JSON.stringify({ data: [{ files: [{}] }] })]) {
    const report = collectCoverageInventory({ ...f, reports: { rust: input(value) } });
    assert.equal(report.reports.find((item) => item.collector === 'rust')?.status, 'invalid');
    assert.equal(report.files[0]?.metrics, undefined);
  }
});

test('default readers reject hardlinked raw profiles rather than publishing an old or unsafe report', (t) => {
  const f = fixture(t);
  f.write('core/internal/work/work.go');
  const raw = f.write(
    '.cache/core/coverage.out',
    'mode: atomic\n' + goLine('internal/work/work.go', 1),
  );
  fs.linkSync(raw, path.join(f.root, 'other-profile'));
  const report = collectCoverageInventory({ ...f });
  assert.equal(report.reports.find((item) => item.collector === 'go')?.status, 'invalid');
  assert.equal(report.files.find((item) => item.language === 'Go')?.status, 'not-measured');
  assert.equal(report.failures.length, 1);
});

test('the standalone index writes private-fixture evidence and appends job summaries with missing reports still visible', (t) => {
  const f = fixture(t);
  const moduleFile = f.write(
    'scripts/ci/coverage-inventory.mts',
    fs.readFileSync(new URL('../../../scripts/ci/coverage-inventory.mts', import.meta.url), 'utf8'),
  );
  f.write('scripts/build.mts');
  f.write('vm/bootstrap.sh');
  f.write('.gitignore', '.cache/\n');
  f.write('.cache/coverage/typescript/lcov.info', lcov('scripts/build.mts'));
  execFileSync('git', ['init', '--quiet'], { cwd: f.root, stdio: 'ignore' });
  const summary = path.join(f.root, 'job-summary.md');
  execFileSync(process.execPath, [moduleFile, '--always'], {
    cwd: f.root,
    env: { ...process.env, GITHUB_SHA: 'a'.repeat(40), GITHUB_STEP_SUMMARY: summary },
    stdio: 'pipe',
  });
  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(f.root, '.cache/coverage/inventory.json'), 'utf8'),
  );
  assert.ok(raw && typeof raw === 'object' && 'sourceCommit' in raw && 'sourceDirty' in raw);
  assert.equal(raw.sourceCommit, 'a'.repeat(40));
  assert.equal(raw.sourceDirty, true);
  const markdown = fs.readFileSync(summary, 'utf8');
  assert.match(markdown, /# Source coverage inventory/);
  assert.match(markdown, /go.*missing/);
  assert.match(markdown, /vm\/bootstrap.sh/);
  assert.throws(() =>
    execFileSync(process.execPath, [moduleFile, 'invalid-argument'], {
      cwd: f.root,
      stdio: 'pipe',
    }),
  );
});

test('Pester command coverage includes zero-hit scripts without representing commands as lines or branches', (t) => {
  const f = fixture(t);
  f.write('native/speech.ps1');
  f.write('scripts/ci/powershell-coverage.ps1');
  const data = {
    metric: 'PowerShell executable commands',
    tool: 'Pester 5.9.0',
    platform: 'Win32NT',
    covered: 2,
    total: 8,
    files: [
      { file: 'native/speech.ps1', covered: 2, total: 3, missingLines: [4] },
      { file: 'scripts/ci/powershell-coverage.ps1', covered: 0, total: 5, missingLines: [1, 2, 3] },
    ],
  };
  const report = collectCoverageInventory({
    ...f,
    platform: 'win32',
    reports: { powershell: input(JSON.stringify(data)) },
  });
  assert.deepEqual(report.languages.find((item) => item.language === 'PowerShell')?.metrics, {
    commands: { covered: 2, total: 8, percent: 25 },
  });
  assert.equal(
    report.files.find((item) => item.file.startsWith('scripts/'))?.metrics?.commands?.percent,
    0,
  );
  assert.equal(report.files[0]?.metrics?.branches, undefined);
  assert.match(coverageInventoryMarkdown(report), /#powershell-command-coverage/);
  for (const changed of [
    { ...data, total: data.total + 1 },
    { ...data, tool: 'Pester unknown' },
    { ...data, files: [data.files[0], data.files[0]] },
  ]) {
    const invalid = collectCoverageInventory({
      ...f,
      reports: { powershell: input(JSON.stringify(changed)) },
    });
    assert.equal(
      invalid.reports.find((item) => item.collector === 'powershell')?.status,
      'invalid',
    );
  }
  const linux = collectCoverageInventory({ ...f, platform: 'linux', reports: {} });
  assert.match(linux.files[0]?.reason ?? '', /Windows PowerShell.*linux/);
});
