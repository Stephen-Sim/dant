import assert from 'node:assert/strict';

/** Assert a fixture result exists before inspecting it; missing values must fail the test. */
export function defined<Value>(
  value: Value,
  message = 'Expected a fixture value',
): NonNullable<Value> {
  assert.ok(value !== null && value !== undefined, message);
  return value;
}

/** Narrow a fixture DOM node only after checking its actual HTML namespace and tag. */
export function htmlTag<Tag extends keyof HTMLElementTagNameMap>(
  value: Node | null | undefined,
  tag: Tag,
): HTMLElementTagNameMap[Tag] {
  assert.ok(
    value &&
      value.nodeType === 1 &&
      'tagName' in value &&
      value.tagName === tag.toUpperCase() &&
      'namespaceURI' in value &&
      value.namespaceURI === 'http://www.w3.org/1999/xhtml',
    'Expected HTML ' + tag,
  );
  return value as HTMLElementTagNameMap[Tag];
}

/** Invoke a checked installed handler with a real event, retaining its async result in isolated fixtures. */
export function invokeHandler(
  node: object | null | undefined,
  type: 'click' | 'change' | 'input' | 'submit',
  supplied?: Event,
): unknown {
  const element = defined(node),
    handler: unknown = Reflect.get(element, 'on' + type);
  assert.equal(typeof handler, 'function', 'Expected installed ' + type + ' handler');
  if (typeof handler !== 'function') throw Error('Missing installed handler');
  const event = supplied ?? new Event(type, { bubbles: true, cancelable: true });
  const result: unknown = Reflect.apply(handler, element, [event]);
  return result;
}
