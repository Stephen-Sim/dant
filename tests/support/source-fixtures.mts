import assert from 'node:assert/strict';
import { parseAst } from 'rollup/parseAst';
import postcss from 'postcss';
import { stripTypeScriptTypes } from 'node:module';
import type { Node } from 'estree';
import type { ChildNode, Container } from 'postcss';
import { isRecord } from '../../scripts/core/manifest-json.mts';
type AstNode = Node & { start: number; end: number };

const programs = new Map<string, ReturnType<typeof parseAst>>();
function program(source: string): ReturnType<typeof parseAst> {
  if (!programs.has(source)) {
    const oldest = programs.keys().next();
    if (programs.size >= 16 && !oldest.done) programs.delete(oldest.value);
    programs.set(source, parseAst(stripTypeScriptTypes(source)));
  }
  const parsed = programs.get(source);
  assert.ok(parsed);
  return parsed;
}
interface MarkerIdentity {
  kind: 'declaration' | 'listener';
  name: string;
}
function markerIdentity(marker: string): MarkerIdentity {
  assert.equal(typeof marker, 'string', 'A source fixture marker must be text');
  const declaration = /^(?:async\s+)?function\s+([\w$]+)\b|^(?:const|let|var)\s+([\w$]+)\b/.exec(
    marker.trim(),
  );
  const declarationName = declaration?.[1] || declaration?.[2];
  if (declarationName) return { kind: 'declaration', name: declarationName };
  const listener = /^document\.addEventListener\(\s*['"]([^'"]+)/.exec(marker.trim());
  if (listener?.[1]) return { kind: 'listener', name: listener[1] };
  throw Error('Unsupported source fixture marker: ' + marker);
}
function isAstNode(value: unknown): value is AstNode {
  // Every child originates from Rollup's typed parser; retain its required range.
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number'
  );
}
function matches(input: unknown, identity: MarkerIdentity): boolean {
  if (!isAstNode(input)) return false;
  let node: AstNode | null | undefined = input;
  if (node.type === 'ExportNamedDeclaration') {
    const declaration = node.declaration;
    if (!isAstNode(declaration)) return false;
    node = declaration;
  }
  if (!node) return false;
  if (identity.kind === 'declaration')
    return (
      (node.type === 'FunctionDeclaration' && node.id?.name === identity.name) ||
      (node.type === 'VariableDeclaration' &&
        node.declarations.some(
          (value) => value.id?.type === 'Identifier' && value.id.name === identity.name,
        ))
    );
  const call = node.type === 'ExpressionStatement' ? node.expression : null;
  return (
    call?.type === 'CallExpression' &&
    call.callee?.type === 'MemberExpression' &&
    call.callee.object.type === 'Identifier' &&
    call.callee.object.name === 'document' &&
    call.callee.property.type === 'Identifier' &&
    call.callee.property.name === 'addEventListener' &&
    call.arguments[0]?.type === 'Literal' &&
    call.arguments[0].value === identity.name
  );
}
export function sourceIndex(source: string, marker: string, after = 0): number {
  const identity = markerIdentity(marker),
    nodes = program(source).body.filter(
      (node) => isAstNode(node) && node.start >= after && matches(node, identity),
    );
  assert.equal(
    nodes.length,
    1,
    `Expected exactly one ${identity.kind} named ${identity.name} after ${after}`,
  );
  const node = nodes[0];
  assert.ok(isAstNode(node));
  return node.start;
}
export function sourceSection(source: string, start: string, end: string): string {
  const first = sourceIndex(source, start),
    last = sourceIndex(source, end, first + 1);
  assert.ok(last > first, 'Source fixture declarations must remain in order');
  return stripTypeScriptTypes(source.slice(first, last));
}
export function sourceDeclaration(source: string, marker: string): string {
  const start = sourceIndex(source, marker),
    node = program(source).body.find((node) => isAstNode(node) && node.start === start);
  assert.ok(isAstNode(node));
  return stripTypeScriptTypes(source.slice(node.start, node.end));
}
function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (!isRecord(node)) return;
  if (isAstNode(node)) visit(node);
  const values: unknown[] = Object.values(node);
  for (const value of values)
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
}
function calleeName(node: unknown): string {
  if (!isAstNode(node)) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'CallExpression') return calleeName(node.callee);
  if (node.type === 'MemberExpression') {
    const property =
      node.property.type === 'Identifier' || node.property.type === 'PrivateIdentifier'
        ? node.property.name
        : node.property.type === 'Literal'
          ? String(node.property.value)
          : '';
    return calleeName(node.object) + '.' + property;
  }
  return '';
}
function expressionStatement(source: string, predicate: (node: AstNode) => boolean): string {
  const nodes: AstNode[] = [];
  walk(program(source), (node) => {
    if (
      node.type === 'ExpressionStatement' &&
      isAstNode(node.expression) &&
      predicate(node.expression)
    )
      nodes.push(node);
  });
  assert.equal(nodes.length, 1, 'Expected one exact expression statement for this fixture');
  const node = nodes[0];
  assert.ok(node);
  return stripTypeScriptTypes(source.slice(node.start, node.end));
}
export function sourceCallStatement(source: string, name: string): string {
  return expressionStatement(
    source,
    (node) => node.type === 'CallExpression' && calleeName(node.callee) === name,
  );
}
export function sourceEventListener(source: string, receiver: string, event: string): string {
  return expressionStatement(
    source,
    (node) =>
      node.type === 'CallExpression' &&
      calleeName(node.callee) === receiver + '.addEventListener' &&
      node.arguments[0]?.type === 'Literal' &&
      node.arguments[0].value === event,
  );
}
export function sourceSelectorBinding(source: string, selector: string): string {
  return expressionStatement(source, (node) => {
    if (
      node.type !== 'CallExpression' ||
      calleeName(node.callee) !== 'document.querySelectorAll.forEach'
    )
      return false;
    const query = node.callee.type === 'MemberExpression' ? node.callee.object : null;
    return (
      query?.type === 'CallExpression' &&
      query.arguments[0]?.type === 'Literal' &&
      query.arguments[0].value === selector
    );
  });
}
export function compactCss(source: string): string {
  // Formatting is normalized only in the assertion view. Production CSS stays
  // readable, and the original declarations and selectors are still checked.
  const compact = (value: string): string => {
    const strings: string[] = [];
    const protectedText = value.replace(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
      (text) => `\u0000${strings.push(text) - 1}\u0000`,
    );
    return protectedText
      .replace(/\s+/g, ' ')
      .replace(/\s*([,:>~])\s*/g, '$1')
      .trim()
      .replace(
        /\u0000(\d+)\u0000/g,
        (_match: string, index: string) => strings[Number(index)] ?? '',
      );
  };
  const children = (node: Container): string =>
    (node.nodes || [])
      .filter((node) => node.type !== 'comment')
      .map(render)
      .join('')
      .replace(/;$/, '');
  const render = (node: ChildNode): string => {
    if (node.type === 'decl')
      return node.prop + ':' + compact(node.value) + (node.important ? '!important' : '') + ';';
    if (node.type === 'rule') return compact(node.selector) + '{' + children(node) + '}';
    if (node.type === 'atrule') {
      const params = compact(node.params || ''),
        prefix = '@' + node.name + (params ? (params.startsWith('(') ? '' : ' ') + params : '');
      return node.nodes ? prefix + '{' + children(node) + '}' : prefix + ';';
    }
    throw Error('Unexpected CSS fixture node: ' + node.type);
  };
  return children(postcss.parse(source)) + '\n';
}
