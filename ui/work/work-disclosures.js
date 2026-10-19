/** User-controlled work-plan expansion survives streamed and status renders. */
export function createWorkDisclosures({ getState, document = globalThis.document } = {}) {
  let scope = null;
  const expanded = new Set(),
    owners = new WeakMap();
  const currentScope = () => {
    const state = getState(),
      vm = state?.settings?.vm;
    return JSON.stringify([
      state?.conversationId ?? null,
      vm?.host ?? null,
      vm?.user ?? null,
      vm?.port ?? null,
    ]);
  };
  function sync() {
    const current = currentScope();
    if (current === scope) return false;
    scope = current;
    expanded.clear();
    return true;
  }
  function remember(node) {
    const id = node.dataset.workPlan;
    if (!id) return;
    if (node.hasAttribute('open')) expanded.add(id);
    else expanded.delete(id);
  }
  function capture() {
    if (sync()) return;
    for (const node of document.querySelectorAll('[data-work-plan]'))
      if (owners.get(node) === scope) remember(node);
  }
  function isOpen(id) {
    sync();
    return expanded.has(id);
  }
  function bind() {
    sync();
    for (const node of document.querySelectorAll('[data-work-plan]')) {
      const owner = scope;
      owners.set(node, owner);
      node.ontoggle = () => {
        if (
          owner === scope &&
          owner === currentScope() &&
          node.isConnected &&
          owners.get(node) === owner
        )
          remember(node);
      };
    }
  }
  return { capture, isOpen, bind };
}
