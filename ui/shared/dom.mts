// Keep interactive nodes alive while state and streamed messages change.
// In particular, replacing a focused textarea aborts Windows IME composition.
const element = (node: Node): node is Element => node.nodeType === 1;
const input = (node: Element): node is HTMLInputElement => node.tagName === 'INPUT';
const textControl = (node: Element): node is HTMLInputElement | HTMLTextAreaElement =>
  node.matches('input, textarea');
const select = (node: Element): node is HTMLSelectElement => node.tagName === 'SELECT';
const key = (node: Node): string | null =>
  element(node)
    ? node.id ||
      node.getAttribute('data-id') ||
      node.getAttribute('data-key') ||
      node.getAttribute('data-action')
    : null;
const compatible = (a: Node, b: Node): boolean =>
  a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);

export function reconcile(parent: Node, next: Node): void {
  const old = [...parent.childNodes];
  const used = new Set<Node>();
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    const desiredKey = key(desired);
    let node: Node | null | undefined = desiredKey
      ? old.find((item) => !used.has(item) && compatible(item, desired))
      : cursor && !used.has(cursor) && compatible(cursor, desired)
        ? cursor
        : null;
    if (!node) node = desired.cloneNode(true);
    else {
      used.add(node);
      patch(node, desired);
    }
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  for (const node of old)
    if (!used.has(node) && node.parentNode === parent) parent.removeChild(node);
}

function patch(node: Node, desired: Node): void {
  // DOM equality ignores a form control's dirty live value. Even unchanged
  // markup must reach controls so a failed settings change can roll back.
  if (
    node.isEqualNode(desired) &&
    !(element(node) && node.matches('input, textarea, select')) &&
    !(element(node) && node.querySelector('input, textarea, select'))
  )
    return;
  if (!element(node) || !element(desired)) {
    if (node.nodeValue !== desired.nodeValue) node.nodeValue = desired.nodeValue;
    return;
  }
  for (const attribute of [...node.attributes]) {
    if (!desired.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
  }
  for (const attribute of [...desired.attributes]) {
    if (node.getAttribute(attribute.name) !== attribute.value)
      node.setAttribute(attribute.name, attribute.value);
  }
  if (textControl(node) && textControl(desired)) {
    // Passwords live only in the user's current field, never in render templates.
    if (
      !['file', 'password'].includes(node.type) &&
      node.id !== 'vm-ime' &&
      node.value !== desired.value
    )
      node.value = desired.value;
    if (input(node) && input(desired) && node.type === 'checkbox') node.checked = desired.checked;
    return;
  }
  reconcile(node, desired);
  if (select(node) && select(desired) && node.value !== desired.value) node.value = desired.value;
}
