import { defined, htmlTag } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';

function fixture(html: string) {
  const { document, Event } = parseHTML(
    '<!doctype html><html><body><main id="app">' + html + '</main></body></html>',
  );
  const parent = defined(document.querySelector<HTMLElement>('#app'));
  return {
    document,
    Event,
    parent,
    update(html: string) {
      const next = document.createElement('main');
      next.innerHTML = html;
      reconcile(defined(parent), next);
      return next;
    },
  };
}
// LinkeDOM does not implement dirty input/checked state or a select.value setter.
// Model those browser IDL properties on real elements, retaining their real DOM,
// attributes, cloning, reconciliation and event dispatch for the tests below.
function liveProperty<Value>(node: Element, name: string, initial: Value) {
  let value = initial,
    writes = 0;
  Object.defineProperty(node, name, {
    configurable: true,
    get: () => value,
    set: (next: Value) => {
      value = next;
      writes++;
    },
  });
  return {
    get value() {
      return value;
    },
    get writes() {
      return writes;
    },
    setUser(next: Value) {
      value = next;
    },
  };
}

test('streamed updates keep the composing Chinese input, selection and event handlers alive', () => {
  const f = fixture(
      '<section><textarea id="composer">中文草稿</textarea><p id="stream">开始</p></section>',
    ),
    input = f.document.querySelector<HTMLTextAreaElement>('#composer');
  defined(input).selectionStart = 2;
  defined(input).selectionEnd = 4;
  let composing = false,
    events = 0;
  defined(input).addEventListener('compositionstart', () => {
    composing = true;
    events++;
  });
  defined(input).addEventListener('compositionend', () => {
    composing = false;
    events++;
  });
  defined(input).dispatchEvent(new f.Event('compositionstart'));
  for (let i = 0; i < 12; i++)
    f.update(
      '<section><textarea id="composer">中文草稿</textarea><p id="stream">回复 ' +
        i +
        '</p></section>',
    );
  assert.equal(f.document.querySelector<HTMLTextAreaElement>('#composer'), input);
  assert.equal(defined(input).value, '中文草稿');
  assert.equal(defined(input).selectionStart, 2);
  assert.equal(defined(input).selectionEnd, 4);
  assert.equal(composing, true);
  defined(input).dispatchEvent(new f.Event('compositionend'));
  assert.equal(composing, false);
  assert.equal(events, 2);
  assert.equal(defined(f.document.querySelector<HTMLElement>('#stream')).textContent, '回复 11');
});

test('VM IME, passwords and file controls retain private live values without setter writes', () => {
  const f = fixture(
    '<textarea id="vm-ime" aria-label="old"></textarea><input id="secret" type="password"><input id="upload" type="file">',
  );
  const controls = ['vm-ime', 'secret', 'upload'].map((id) => f.document.getElementById(id)),
    properties = controls.map((node, index) =>
      liveProperty(
        defined(node),
        'value',
        ['正在输入中文', 'private-token', 'C:/fakepath/report.pdf'][index],
      ),
    );
  f.update(
    '<textarea id="vm-ime" aria-label="new">stale render</textarea><input id="secret" type="password" disabled><input id="upload" type="file" accept="image/*">',
  );
  controls.forEach((node, index) => {
    assert.equal(f.document.getElementById(defined(node).id), node);
    assert.equal(defined(properties[index]).writes, 0);
    assert.equal(
      defined(properties[index]).value,
      ['正在输入中文', 'private-token', 'C:/fakepath/report.pdf'][index],
    );
    assert.equal(defined(node).hasAttribute('value'), false);
  });
  assert.equal(defined(controls[0]).getAttribute('aria-label'), 'new');
  assert.equal(htmlTag(controls[1], 'input').disabled, true);
  assert.equal(defined(controls[2]).getAttribute('accept'), 'image/*');
});

test('attributes are added, changed and removed while text and comment nodes are patched in place', () => {
  const f = fixture(
      '<article id="message" class="old" title="remove">old<!--before--><b>same</b></article>',
    ),
    article = htmlTag(f.parent.firstChild, 'article'),
    text = defined(article).firstChild,
    comment = defined(text).nextSibling,
    bold = defined(article).lastChild;
  f.update(
    '<article id="message" class="new" aria-live="polite">new<!--after--><b>same</b></article>',
  );
  assert.equal(defined(f.parent).firstChild, article);
  assert.equal(defined(article).className, 'new');
  assert.equal(defined(article).hasAttribute('title'), false);
  assert.equal(defined(article).getAttribute('aria-live'), 'polite');
  assert.equal(defined(article).firstChild, text);
  assert.equal(defined(text).nodeValue, 'new');
  assert.equal(defined(text).nextSibling, comment);
  assert.equal(defined(comment).nodeValue, 'after');
  assert.equal(defined(article).lastChild, bold);
});

test('all supported keys reorder existing nodes and remove missing or incompatible nodes', () => {
  const f = fixture(
      '<div id="id">id</div><div data-id="message">message</div><div data-key="key">key</div><button data-action="send">send</button><i>remove</i>',
    ),
    nodes = [...defined(f.parent).children];
  let clicks = 0;
  defined(nodes[3]).addEventListener('click', () => clicks++);
  f.update(
    '<button data-action="send">send</button><div data-key="key">key</div><div data-id="message">updated</div><div id="id">id</div><span data-key="new">new</span>',
  );
  assert.deepEqual([...defined(f.parent).children].slice(0, 4), [
    nodes[3],
    nodes[2],
    nodes[1],
    nodes[0],
  ]);
  assert.equal(defined(nodes[1]).textContent, 'updated');
  assert.equal(defined(nodes[4]).parentNode, null);
  defined(defined(f.parent).firstChild).dispatchEvent(new f.Event('click'));
  assert.equal(clicks, 1);
  const prior = defined(f.parent).querySelector<HTMLButtonElement>('[data-key="key"]');
  f.update('<section data-key="key">replacement</section>');
  assert.notEqual(defined(f.parent).firstChild, prior);
  assert.equal(defined(defined(f.parent).firstElementChild).tagName, 'SECTION');
  assert.equal(defined(prior).parentNode, null);
});

test('long keyed message lists retain identity with a bounded number of key reads', () => {
  const count = 623,
    f = fixture(
      Array.from(
        { length: count },
        (_, index) => `<article data-id="message-${index}">Message ${index}</article>`,
      ).join(''),
    ),
    original = [...f.parent.children];
  let reads = 0;
  for (const node of original) {
    const read = node.getAttribute.bind(node);
    node.getAttribute = (name: string) => {
      reads++;
      return read(name);
    };
  }
  f.update(
    Array.from(
      { length: count },
      (_, index) =>
        `<article data-id="message-${count - index - 1}">Message ${count - index - 1}</article>`,
    ).join(''),
  );
  assert.deepEqual([...f.parent.children], [...original].reverse());
  assert.ok(reads < count * 20, 'key matching must not rescan the full history for each message');
});

test('duplicate keys retain compatible nodes in their original order and unkeyed siblings remain positional', () => {
  const f = fixture(
      '<button data-action="same">One</button><div data-action="same">Other tag</div><button data-action="same">Two</button><i>Unkeyed</i>',
    ),
    original = [...f.parent.children];
  f.update(
    '<button data-action="same">First</button><button data-action="same">Second</button><div data-action="same">Other</div><i>Unkeyed</i>',
  );
  assert.deepEqual([...f.parent.children], [original[0], original[2], original[1], original[3]]);
});

test('normal text inputs, textareas and checkbox live state follow the requested render', () => {
  const f = fixture(
      '<input id="name" value="old"><textarea id="draft">old</textarea><input id="check" type="checkbox">',
    ),
    input = f.document.querySelector<HTMLElement>('#name'),
    textarea = f.document.querySelector<HTMLElement>('#draft'),
    checkbox = f.document.querySelector<HTMLElement>('#check');
  const inputValue = liveProperty(defined(input), 'value', 'unsaved'),
    textValue = liveProperty(defined(textarea), 'value', 'unsaved'),
    checked = liveProperty(defined(checkbox), 'checked', false);
  const next = f.document.createElement('main');
  next.innerHTML =
    '<input id="name" value="new"><textarea id="draft">新的草稿</textarea><input id="check" type="checkbox" checked>';
  Object.defineProperty(defined(next.querySelector<HTMLInputElement>('#check')), 'checked', {
    value: true,
  });
  reconcile(f.parent, next);
  assert.equal(inputValue.value, 'new');
  assert.equal(textValue.value, '新的草稿');
  assert.equal(inputValue.writes, 1);
  assert.equal(textValue.writes, 1);
  assert.equal(checked.value, true);
  assert.equal(checked.writes, 1);
  assert.equal(f.document.querySelector<HTMLElement>('#draft'), textarea);
});

test('select choices and live selection update without replacing the control', () => {
  const f = fixture(
      '<select id="language"><option value="zh" selected>中文</option><option value="en">English</option></select>',
    ),
    select = htmlTag(f.parent.firstChild, 'select'),
    live = liveProperty(defined(select), 'value', 'zh'),
    chinese = defined(select).firstChild;
  f.update(
    '<select id="language" aria-label="Language"><option value="zh">中文</option><option value="en" selected>English</option><option value="auto">Auto</option></select>',
  );
  assert.equal(defined(f.parent).firstChild, select);
  assert.equal(defined(select).firstChild, chinese);
  assert.equal(defined(select).children.length, 3);
  assert.equal(live.value, 'en');
  assert.equal(live.writes, 1);
  assert.equal(defined(select).getAttribute('aria-label'), 'Language');
});

test('a rejected checkbox or selection change rolls back even when its ancestor markup is unchanged', () => {
  const html =
      '<section id="settings"><div><input id="notify" type="checkbox" checked><select id="voice"><option value="ember" selected>Ember</option><option value="marin">Marin</option></select></div></section>',
    f = fixture(html),
    checkbox = f.document.querySelector<HTMLElement>('#notify'),
    select = f.document.querySelector<HTMLElement>('#voice'),
    checked = liveProperty(defined(checkbox), 'checked', false),
    voice = liveProperty(defined(select), 'value', 'marin');
  const next = f.document.createElement('main');
  next.innerHTML = html;
  Object.defineProperty(next.querySelector<HTMLElement>('#notify'), 'checked', { value: true });
  assert.equal(
    defined(defined(f.parent).firstChild).isEqualNode(next.firstChild),
    true,
    'browser live state is absent from DOM equality',
  );
  reconcile(f.parent, next);
  assert.equal(checked.value, true);
  assert.equal(voice.value, 'ember');
  assert.equal(f.document.querySelector<HTMLElement>('#notify'), checkbox);
  assert.equal(f.document.querySelector<HTMLElement>('#voice'), select);
});

test('changed tag, key or node type replaces only incompatible content and empty renders remove old nodes', () => {
  const f = fixture('<p id="a">A</p><p id="b">B</p>'),
    a = defined(f.parent).firstChild,
    b = defined(f.parent).lastChild;
  f.update('<div id="a">A</div><p id="c">C</p>tail');
  assert.notEqual(defined(f.parent).firstChild, a);
  assert.notEqual(defined(f.parent).children[1], b);
  assert.equal(defined(a).parentNode, null);
  assert.equal(defined(b).parentNode, null);
  const tail = defined(f.parent).lastChild;
  f.update('<div id="a">A</div><p id="c">C</p><!--tail-->');
  assert.notEqual(defined(f.parent).lastChild, tail);
  assert.equal(defined(defined(f.parent).lastChild).nodeType, 8);
  f.update('');
  assert.equal(defined(f.parent).childNodes.length, 0);
});
