import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { format } from 'prettier';
import { nativeProtocolOutputs } from '../config/native-protocol.mts';
import { parseComputerResources } from '../../ui/computer/resource-config.mts';
import { isRecord } from './manifest-json.mts';

const SCHEMA_VERSION = 1;
const MAX_DOMAINS = 128;
const MAX_VALUES = 128;
const MAX_LANGUAGES = 128;
const BASE_LANGUAGES = new Set(['en', 'zh']);
const LANGUAGE_CODE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
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
    '// Code generated from resources/contracts/state-domains.json; DO NOT EDIT.',
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

/** Go embeds the canonical locale data; the second physical copy is generated. */
export async function languageResourceOutputs(
  root: string,
): Promise<readonly (readonly [string, string])[]> {
  const directory = path.join(root, 'resources/i18n');
  const raw = await fs.readFile(path.join(directory, 'language-registry.json'), 'utf8');
  const registry: unknown = JSON.parse(raw);
  if (!Array.isArray(registry) || !registry.length || registry.length > MAX_LANGUAGES)
    throw Error('Invalid shared language registry');
  const codes = new Set<string>();
  for (const item of registry) {
    if (
      !isRecord(item) ||
      typeof item.code !== 'string' ||
      !LANGUAGE_CODE.test(item.code) ||
      codes.has(item.code)
    )
      throw Error('Invalid shared language code');
    codes.add(item.code);
  }
  for (const code of BASE_LANGUAGES) if (!codes.has(code)) throw Error('Missing base language');
  const expected = [...codes]
    .filter((code) => !BASE_LANGUAGES.has(code))
    .map((code) => code + '.json')
    .sort();
  const entries = await fs.readdir(path.join(directory, 'locales'), { withFileTypes: true });
  if (
    entries.some((entry) => !entry.isFile()) ||
    entries
      .map((entry) => entry.name)
      .sort()
      .join('\0') !== expected.join('\0')
  )
    throw Error('Shared language catalogs do not match the registry');
  const outputs: [string, string][] = [['core/internal/i18n/language-registry.json', raw]];
  for (const name of expected) {
    const contents = await fs.readFile(path.join(directory, 'locales', name), 'utf8');
    const catalog: unknown = JSON.parse(contents);
    if (
      !isRecord(catalog) ||
      Object.values(catalog).some((value) => typeof value !== 'string' || !value.trim())
    )
      throw Error('Invalid shared language catalog');
    outputs.push(['core/internal/i18n/locales/' + name, contents]);
  }
  return outputs;
}

/** Keep the native/Go copy byte-identical to the validated provisioning policy. */
export async function computerResourceOutputs(root: string): Promise<[string, string][]> {
  const raw = await fs.readFile(path.join(root, 'resources/config/computer.json'), 'utf8');
  parseComputerResources(raw);
  return [['core/internal/config/assets/computer.json', raw]];
}

export async function generateContracts(root: string, check: boolean): Promise<void> {
  const schema = stateSchema(
    JSON.parse(
      await fs.readFile(path.join(root, 'resources/contracts/state-domains.json'), 'utf8'),
    ),
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
  const outputs = [
    [
      'ui/shared/states.mts',
      await format(renderTypeScriptStates(schema), {
        parser: 'typescript',
        singleQuote: true,
        printWidth: 100,
        trailingComma: 'all',
      }),
    ],
    ['core/internal/contracts/states.go', formatted.stdout],
    [
      'core/internal/config/assets/protocol.json',
      await fs.readFile(path.join(root, 'resources/config/protocol.json'), 'utf8'),
    ],
    ...(await languageResourceOutputs(root)),
    ...(await computerResourceOutputs(root)),
    ...(await nativeProtocolOutputs(root)),
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
