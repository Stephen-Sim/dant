import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../ui/shared/dom.js';

function fixture(html) {
  const { document, Event } = parseHTML(
    '<!doctype html><html><body><main id="app">' + html + '</main></body></html>',
  );
  const parent = document.querySelector('#app');
  return {
    document,
    Event,
    parent,
    update(html) {
      const next = document.createElement('main');
      next.innerHTML = html;
      reconcile(parent, next);
      return next;
    },
  };
}
// LinkeDOM does not implement dirty input/checked state or a select.value setter.
// Model those browser IDL properties on real elements, retaining their real DOM,
// attributes, cloning, reconciliation and event dispatch for the tests below.
function liveProperty(node, name, initial) {
  let value = initial,
    writes = 0;
  Object.defineProperty(node, name, {
    configurable: true,
    get: () => value,
    set: (next) => {
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
    setUser(next) {
      value = next;
    },
  };
}

test('streamed updates keep the composing Chinese input, selection and event handlers alive', () => {
  const f = fixture(
      '<section><textarea id="composer">中文草稿</textarea><p id="stream">开始</p></section>',
    ),
    input = f.document.querySelector('#composer');
  input.selectionStart = 2;
  input.selectionEnd = 4;
  let composing = false,
    events = 0;
  input.addEventListener('compositionstart', () => {
    composing = true;
    events++;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    events++;
  });
  input.dispatchEvent(new f.Event('compositionstart'));
  for (let i = 0; i < 12; i++)
    f.update(
      '<section><textarea id="composer">中文草稿</textarea><p id="stream">回复 ' +
        i +
        '</p></section>',
    );
  assert.equal(f.document.querySelector('#composer'), input);
  assert.equal(input.value, '中文草稿');
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 4);
  assert.equal(composing, true);
  input.dispatchEvent(new f.Event('compositionend'));
  assert.equal(composing, false);
  assert.equal(events, 2);
  assert.equal(f.document.querySelector('#stream').textContent, '回复 11');
});

test('VM IME, passwords and file controls retain private live values without setter writes', () => {
  const f = fixture(
    '<textarea id="vm-ime" aria-label="old"></textarea><input id="secret" type="password"><input id="upload" type="file">',
  );
  const controls = ['vm-ime', 'secret', 'upload'].map((id) => f.document.getElementById(id)),
    properties = controls.map((node, index) =>
      liveProperty(
        node,
        'value',
        ['正在输入中文', 'private-token', 'C:/fakepath/report.pdf'][index],
      ),
    );
  f.update(
    '<textarea id="vm-ime" aria-label="new">stale render</textarea><input id="secret" type="password" disabled><input id="upload" type="file" accept="image/*">',
  );
  controls.forEach((node, index) => {
    assert.equal(f.document.getElementById(node.id), node);
    assert.equal(properties[index].writes, 0);
    assert.equal(
      properties[index].value,
      ['正在输入中文', 'private-token', 'C:/fakepath/report.pdf'][index],
    );
    assert.equal(node.hasAttribute('value'), false);
  });
  assert.equal(controls[0].getAttribute('aria-label'), 'new');
  assert.equal(controls[1].disabled, true);
  assert.equal(controls[2].getAttribute('accept'), 'image/*');
});

test('attributes are added, changed and removed while text and comment nodes are patched in place', () => {
  const f = fixture(
      '<article id="message" class="old" title="remove">old<!--before--><b>same</b></article>',
    ),
    article = f.parent.firstChild,
    text = article.firstChild,
    comment = text.nextSibling,
    bold = article.lastChild;
  f.update(
    '<article id="message" class="new" aria-live="polite">new<!--after--><b>same</b></article>',
  );
  assert.equal(f.parent.firstChild, article);
  assert.equal(article.className, 'new');
  assert.equal(article.hasAttribute('title'), false);
  assert.equal(article.getAttribute('aria-live'), 'polite');
  assert.equal(article.firstChild, text);
  assert.equal(text.nodeValue, 'new');
  assert.equal(text.nextSibling, comment);
  assert.equal(comment.nodeValue, 'after');
  assert.equal(article.lastChild, bold);
});

test('all supported keys reorder existing nodes and remove missing or incompatible nodes', () => {
  const f = fixture(
      '<div id="id">id</div><div data-id="message">message</div><div data-key="key">key</div><button data-action="send">send</button><i>remove</i>',
    ),
    nodes = [...f.parent.children];
  let clicks = 0;
  nodes[3].addEventListener('click', () => clicks++);
  f.update(
    '<button data-action="send">send</button><div data-key="key">key</div><div data-id="message">updated</div><div id="id">id</div><span data-key="new">new</span>',
  );
  assert.deepEqual([...f.parent.children].slice(0, 4), [nodes[3], nodes[2], nodes[1], nodes[0]]);
  assert.equal(nodes[1].textContent, 'updated');
  assert.equal(nodes[4].parentNode, null);
  f.parent.firstChild.dispatchEvent(new f.Event('click'));
  assert.equal(clicks, 1);
  const prior = f.parent.querySelector('[data-key="key"]');
  f.update('<section data-key="key">replacement</section>');
  assert.notEqual(f.parent.firstChild, prior);
  assert.equal(f.parent.firstChild.tagName, 'SECTION');
  assert.equal(prior.parentNode, null);
});

test('normal text inputs, textareas and checkbox live state follow the requested render', () => {
  const f = fixture(
      '<input id="name" value="old"><textarea id="draft">old</textarea><input id="check" type="checkbox">',
    ),
    input = f.document.querySelector('#name'),
    textarea = f.document.querySelector('#draft'),
    checkbox = f.document.querySelector('#check');
  const inputValue = liveProperty(input, 'value', 'unsaved'),
    textValue = liveProperty(textarea, 'value', 'unsaved'),
    checked = liveProperty(checkbox, 'checked', false);
  const next = f.document.createElement('main');
  next.innerHTML =
    '<input id="name" value="new"><textarea id="draft">新的草稿</textarea><input id="check" type="checkbox" checked>';
  Object.defineProperty(next.querySelector('#check'), 'checked', { value: true });
  reconcile(f.parent, next);
  assert.equal(inputValue.value, 'new');
  assert.equal(textValue.value, '新的草稿');
  assert.equal(inputValue.writes, 1);
  assert.equal(textValue.writes, 1);
  assert.equal(checked.value, true);
  assert.equal(checked.writes, 1);
  assert.equal(f.document.querySelector('#draft'), textarea);
});

test('select choices and live selection update without replacing the control', () => {
  const f = fixture(
      '<select id="language"><option value="zh" selected>中文</option><option value="en">English</option></select>',
    ),
    select = f.parent.firstChild,
    live = liveProperty(select, 'value', 'zh'),
    chinese = select.firstChild;
  f.update(
    '<select id="language" aria-label="Language"><option value="zh">中文</option><option value="en" selected>English</option><option value="auto">Auto</option></select>',
  );
  assert.equal(f.parent.firstChild, select);
  assert.equal(select.firstChild, chinese);
  assert.equal(select.children.length, 3);
  assert.equal(live.value, 'en');
  assert.equal(live.writes, 1);
  assert.equal(select.getAttribute('aria-label'), 'Language');
});

test('a rejected checkbox or selection change rolls back even when its ancestor markup is unchanged', () => {
  const html =
      '<section id="settings"><div><input id="notify" type="checkbox" checked><select id="voice"><option value="ember" selected>Ember</option><option value="marin">Marin</option></select></div></section>',
    f = fixture(html),
    checkbox = f.document.querySelector('#notify'),
    select = f.document.querySelector('#voice'),
    checked = liveProperty(checkbox, 'checked', false),
    voice = liveProperty(select, 'value', 'marin');
  const next = f.document.createElement('main');
  next.innerHTML = html;
  Object.defineProperty(next.querySelector('#notify'), 'checked', { value: true });
  assert.equal(
    f.parent.firstChild.isEqualNode(next.firstChild),
    true,
    'browser live state is absent from DOM equality',
  );
  reconcile(f.parent, next);
  assert.equal(checked.value, true);
  assert.equal(voice.value, 'ember');
  assert.equal(f.document.querySelector('#notify'), checkbox);
  assert.equal(f.document.querySelector('#voice'), select);
});

test('changed tag, key or node type replaces only incompatible content and empty renders remove old nodes', () => {
  const f = fixture('<p id="a">A</p><p id="b">B</p>'),
    a = f.parent.firstChild,
    b = f.parent.lastChild;
  f.update('<div id="a">A</div><p id="c">C</p>tail');
  assert.notEqual(f.parent.firstChild, a);
  assert.notEqual(f.parent.children[1], b);
  assert.equal(a.parentNode, null);
  assert.equal(b.parentNode, null);
  const tail = f.parent.lastChild;
  f.update('<div id="a">A</div><p id="c">C</p><!--tail-->');
  assert.notEqual(f.parent.lastChild, tail);
  assert.equal(f.parent.lastChild.nodeType, 8);
  f.update('');
  assert.equal(f.parent.childNodes.length, 0);
});
