import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { format } from 'prettier';
import { isRecord } from '../../src/contracts/json.mts';

const SCHEMA_VERSION = 1;
const MAX_DOMAINS = 128;
const MAX_VALUES = 128;
const identifier = /^[A-Z][A-Za-z0-9]{0,63}$/;
const wireValue = /^[a-z][A-Za-z0-9_-]{0,63}$/;

export interface StateSchema {
  version: 1;
  domains: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** A single data source owns wire vocabulary in both runtimes. */
export function stateSchema(value: unknown): StateSchema {
  if (
    !isRecord(value) ||
    value.version !== SCHEMA_VERSION ||
    Object.keys(value).some((key) => key !== 'version' && key !== 'domains') ||
    !isRecord(value.domains)
  )
    throw Error('Invalid state schema');
  const entries = Object.entries(value.domains);
  if (!entries.length || entries.length > MAX_DOMAINS) throw Error('Invalid state domains');
  const domains: Record<string, Readonly<Record<string, string>>> = Object.create(null);
  const symbols = new Set(entries.map(([name]) => name));
  for (const [name, members] of entries) {
    if (!identifier.test(name) || !isRecord(members)) throw Error('Invalid state domain');
    const values = Object.entries(members);
    if (!values.length || values.length > MAX_VALUES) throw Error('Invalid state members');
    const wires = new Set<string>();
    const accepted: Record<string, string> = Object.create(null);
    for (const [member, wire] of values) {
      const symbol = name + member;
      if (
        !identifier.test(member) ||
        typeof wire !== 'string' ||
        !wireValue.test(wire) ||
        wires.has(wire) ||
        symbols.has(symbol)
      )
        throw Error('Invalid state member');
      wires.add(wire);
      symbols.add(symbol);
      accepted[member] = wire;
    }
    domains[name] = Object.freeze(accepted);
  }
  return Object.freeze({ version: SCHEMA_VERSION, domains: Object.freeze(domains) });
}

export function renderTypeScriptStates(schema: StateSchema): string {
  return [
    '/** Generated from state-domains.json by scripts/core/generate-contracts.mts. */',
    '// Keep task, chat-task and durable-work vocabularies distinct.',
    ...Object.entries(schema.domains).flatMap(([name, members]) => [
      `export const ${name} = Object.freeze({`,
      ...Object.entries(members).map(([key, value]) => `  ${key}: '${value}',`),
      '} as const);',
      `export type ${name}Value = (typeof ${name})[keyof typeof ${name}];`,
      '',
    ]),
    '/** Validate a wire value without coercion or an invented fallback. */',
    'export function isEnumValue<Domain extends Readonly<Record<string, string>>>(',
    '  domain: Domain,',
    '  value: unknown,',
    '): value is Domain[keyof Domain] {',
    "  return typeof value === 'string' && Object.values(domain).some((entry) => entry === value);",
    '}',
    '',
  ].join('\n');
}

export function renderGoStates(schema: StateSchema): string {
  return [
    '// Code generated from src/contracts/state-domains.json; DO NOT EDIT.',
    'package contracts',
    '',
    'import ("encoding/json"; "errors")',
    '',
    ...Object.entries(schema.domains).flatMap(([name, members]) => [
      `type ${name} string`,
      'const (',
      ...Object.entries(members).map(([member, wire]) => `\t${name}${member} ${name} = "${wire}"`),
      ')',
      `func (value ${name}) Valid() bool {`,
      '\tswitch value {',
      `\tcase ${Object.keys(members)
        .map((member) => name + member)
        .join(', ')}:`,
      '\t\treturn true',
      '\tdefault:',
      '\t\treturn false',
      '\t}',
      '}',
      `func (value *${name}) UnmarshalJSON(data []byte) error {`,
      '\tvar wire string',
      `\tif err := json.Unmarshal(data, &wire); err != nil || !${name}(wire).Valid() {`,
      `\t\treturn errors.New("invalid ${name}")`,
      '\t}',
      `\t*value = ${name}(wire)`,
      '\treturn nil',
      '}',
      `func (value ${name}) MarshalJSON() ([]byte, error) {`,
      `\tif !value.Valid() { return nil, errors.New("invalid ${name}") }`,
      '\treturn json.Marshal(string(value))',
      '}',
      '',
    ]),
  ].join('\n');
}

export function renderGoProtocol(value: unknown): string {
  const fields = [
    'version',
    'requestMaxBytes',
    'responseMaxBytes',
    'requestIdMaxChars',
    'workers',
    'queueCapacity',
    'defaultDeadlineMs',
    'maxDeadlineMs',
    'shutdownMs',
    'maxSessionRequests',
    'snapshotMaxBytes',
  ] as const;
  if (
    !isRecord(value) ||
    value.version !== SCHEMA_VERSION ||
    Object.keys(value).length !== fields.length ||
    !fields.every(
      (name) =>
        typeof value[name] === 'number' && Number.isSafeInteger(value[name]) && value[name] > 0,
    )
  )
    throw Error('Invalid core protocol limits');
  return [
    '// Code generated from src/contracts/core-protocol.json; DO NOT EDIT.',
    'package contracts',
    'const (',
    ...fields.map((name) => `Core${name[0]?.toUpperCase()}${name.slice(1)} = ${value[name]}`),
    ')',
    '',
  ].join('\n');
}

export async function generateContracts(root: string, check: boolean): Promise<void> {
  const schema = stateSchema(
    JSON.parse(await fs.readFile(path.join(root, 'src/contracts/state-domains.json'), 'utf8')),
  );
  const { resolveGoToolchain } = await import('./go.mts');
  const toolchain = resolveGoToolchain(root);
  const formatted = spawnSync(toolchain.gofmt, [], {
    input: renderGoStates(schema),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: toolchain.env,
  });
  if (formatted.error || formatted.status !== 0) throw Error('Go contract formatting failed');
  const protocol = JSON.parse(
    await fs.readFile(path.join(root, 'src/contracts/core-protocol.json'), 'utf8'),
  );
  const formattedProtocol = spawnSync(toolchain.gofmt, [], {
    input: renderGoProtocol(protocol),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: toolchain.env,
  });
  if (formattedProtocol.error || formattedProtocol.status !== 0)
    throw Error('Go protocol formatting failed');
  const outputs = [
    [
      'src/contracts/states.mts',
      await format(renderTypeScriptStates(schema), {
        parser: 'typescript',
        singleQuote: true,
        printWidth: 100,
        trailingComma: 'all',
      }),
    ],
    ['core/internal/contracts/states.go', formatted.stdout],
    ['core/internal/contracts/core_protocol.go', formattedProtocol.stdout],
  ] as const;
  for (const [relative, contents] of outputs) {
    const destination = path.join(root, relative);
    if (check) {
      if ((await fs.readFile(destination, 'utf8')) !== contents)
        throw Error(`Generated contract differs: ${relative}`);
    } else {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, contents, 'utf8');
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check'))
    throw Error('Unknown contract generation option');
  await generateContracts(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    args[0] === '--check',
  );
}
