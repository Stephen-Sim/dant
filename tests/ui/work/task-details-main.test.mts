import { defined } from '../../support/fixture-assertions.mts';
import type { Attachment, UiModal, WorkReplyTarget } from '../../../ui/shared/contracts.mts';
import type { createTaskDetails } from '../../../ui/work/task-details.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceIndex, sourceDeclaration } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
const file = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Saved result.png',
  type: 'image/png',
};

test('task details use the shared chat reply selection and open saved files without requiring visible chat history', async () => {
  let options: Parameters<typeof createTaskDetails>[0] | undefined;
  const selected: WorkReplyTarget[] = [],
    modals: UiModal[] = [],
    previews: Attachment[] = [],
    downloads: Attachment[] = [],
    context = uiEntrypointFixture({
      document: {},
      state: { messages: [] },
      language: () => 'en',
      modal: null,
      eventConnected: true,
      api() {
        throw Error('Selecting a task must not submit it');
      },
      render() {},
      openModal: (value: UiModal) => modals.push(value),
      ico: () => '',
      taskReplies: { select: (target: WorkReplyTarget) => selected.push(target) },
      createTaskDetails: (value: Parameters<typeof createTaskDetails>[0]) => {
        options = value;
        return {};
      },
      canPreviewFile: (value: Attachment) => value.type === 'text/plain',
      filePreview: { open: (value: Attachment) => previews.push(value) },
      downloads: { save: async (value: Attachment) => downloads.push(value) },
      toast() {},
    });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(stripTypeScriptTypes(sourceDeclaration(source, 'const taskDetails=')), context);
  const target = { workId: 'saved-work', turnId: 'saved-turn', conversationId: 'chat' };
  defined(defined(options).onReply)(target);
  assert.equal(selected[0], target);
  defined(defined(options).onFile)(file);
  assert.deepEqual(JSON.parse(JSON.stringify(modals)), [{ type: 'image', fileId: file.id }]);
  assert.equal(previews.length, 0);
  const text = { ...file, type: 'text/plain', name: 'Saved result.txt' };
  defined(defined(options).onFile)(text);
  assert.equal(previews[0], text);
  const binary = { ...file, type: 'application/pdf', name: 'Saved result.pdf' };
  defined(defined(options).onFile)(binary);
  await defined(defined(options).onDownload)(file);
  assert.deepEqual(downloads, [binary, file]);
});

test('image and task detail modals resolve validated project files even after the source message was pruned', () => {
  const modal: UiModal = { type: 'image', fileId: file.id };
  const lookups: unknown[] = [],
    context = uiEntrypointFixture({
      modal,
      managedSettings: { renderModal: () => null },
      chatHistory: { renderModal: () => null },
      conversationFiles: () => [],
      taskDetails: {
        file: (id: unknown) => {
          lookups.push(id);
          return id === file.id ? file : null;
        },
        renderModal: () => '<section>Task details</section>',
      },
      esc: (value: unknown) => String(value ?? ''),
      t: (key: unknown) => key,
      ico: () => '',
      button: () => '',
      fileURL: (value: Attachment) => '/api/files/' + value.id,
    });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(
    stripTypeScriptTypes(
      source.slice(
        sourceIndex(source, 'function renderModal(){'),
        sourceIndex(source, 'function openModal('),
      ),
    ),
    context,
  );
  assert.match(context.renderModal(), /Saved result\.png/);
  assert.deepEqual(lookups, [file.id]);
  context.modal.fileId = 'missing';
  assert.equal(context.renderModal(), '');
  context.modal = { type: 'task-detail' };
  assert.equal(context.renderModal(), '<section>Task details</section>');
});
