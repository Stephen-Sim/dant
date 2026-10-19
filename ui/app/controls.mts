export function requiredData(element: HTMLElement, key: string): string {
  const value = element.dataset[key];
  if (!value) throw Error('Missing UI action identity');
  return value;
}
export function formInput(form: HTMLFormElement, name: string): HTMLInputElement {
  const input = form.elements.namedItem(name);
  if (!isInput(input)) throw Error('Missing form input');
  return input;
}
export function formSelect(form: HTMLFormElement, name: string): HTMLSelectElement {
  const select = form.elements.namedItem(name);
  if (!isSelect(select)) throw Error('Missing form select');
  return select;
}
export function serviceStatusLabel(status: string | undefined): string {
  const labels = {
    checking: 'serviceChecking',
    updating: 'serviceUpdating',
    pending: 'servicePending',
    current: 'serviceCurrent',
    failed: 'serviceFailed',
  };
  return status && Object.hasOwn(labels, status)
    ? labels[status as keyof typeof labels]
    : 'servicePending';
}

function isInput(value: Element | RadioNodeList | null): value is HTMLInputElement {
  return value !== null && 'tagName' in value && value.tagName === 'INPUT';
}
function isSelect(value: Element | RadioNodeList | null): value is HTMLSelectElement {
  return value !== null && 'tagName' in value && value.tagName === 'SELECT';
}
