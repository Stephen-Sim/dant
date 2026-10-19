import type { Express } from 'express';
import type {
  ConversationStoreState,
  MessagePatch,
  ChatAttachment,
} from '../conversation/types.ts';
import type { DeliverableCollector } from './deliverables.mts';
import { isRecord, errorMessage } from '../contracts/json.mts';
interface OutputLinkPersistence {
  state: Pick<ConversationStoreState, 'conversationId' | 'messages'>;
  update(id: string, patch: MessagePatch): unknown;
}
export interface OutputLinkRecoveryOptions {
  store: OutputLinkPersistence;
  collector: DeliverableCollector;
  outputDir: string | (() => string);
  onChange?: () => void;
}
import path from 'node:path';
import { marked } from 'marked';
import { MAX_MESSAGE_ATTACHMENTS } from './attachments.mts';
import { outputReference } from './deliverables.mts';

const unavailable = () =>
  Object.assign(Error('The referenced output file is missing, restricted or unavailable.'), {
    status: 404,
  });
const invalid = () =>
  Object.assign(Error('Choose a local output link from this assistant message.'), { status: 400 });

function storedLink(text: unknown, href: string) {
  if (typeof text !== 'string' || text.length > 120000) return false;
  let found = false;
  marked.walkTokens(marked.lexer(text), (token) => {
    if (
      !['link', 'image'].includes(token.type) ||
      !('href' in token) ||
      typeof token.href !== 'string'
    )
      return;
    let rendered;
    try {
      rendered = encodeURI(token.href).replace(/%25/g, '%');
    } catch {
      return;
    }
    if (token.href === href || rendered === href) found = true;
  });
  return found;
}
function outputPath(outputDir: string, href: string) {
  const root = path.resolve(outputDir),
    relative = outputReference(root, href);
  if (!relative) throw unavailable();
  return path.join(root, relative);
}

/** Explicit recovery of a saved reference, never a directory scan or model task. */
export function createOutputLinkRecovery({
  store,
  collector,
  outputDir,
  onChange = () => {},
}: OutputLinkRecoveryOptions) {
  return {
    resolve(messageId: unknown, body: unknown) {
      if (
        !isRecord(body) ||
        Object.keys(body).some((key) => !['conversationId', 'href'].includes(key)) ||
        typeof body.href !== 'string' ||
        !body.href ||
        body.href.length > 8192 ||
        /[\x00-\x1f\x7f]/.test(body.href)
      )
        throw invalid();
      if (
        typeof body.conversationId !== 'string' ||
        body.conversationId !== store.state.conversationId
      )
        throw Object.assign(
          Error('The conversation changed before its output link could be restored.'),
          { status: 409 },
        );
      const message = store.state.messages.find((item) => item.id === messageId);
      if (!message || message.role !== 'assistant') throw unavailable();
      if (!storedLink(message.text, body.href)) throw invalid();
      const root = typeof outputDir === 'function' ? outputDir() : outputDir,
        target = outputPath(root, body.href),
        attachments = Array.isArray(message.attachments) ? message.attachments : [];
      // Reuse the immutable snapshot already attached to this exact message,
      // even if the original output has subsequently changed or disappeared.
      const existing = attachments.filter(
        (file) => typeof file?.sourcePath === 'string' && path.resolve(file.sourcePath) === target,
      );
      if (existing.length > 1) throw unavailable();
      const result = (attachment: ChatAttachment, reused: boolean) => ({
        conversationId: store.state.conversationId,
        messageId: message.id,
        attachment,
        restoredSnapshot: true,
        reused,
      });
      const existingAttachment = existing[0];
      if (existingAttachment) {
        try {
          collector.attachments.read(existingAttachment.id);
        } catch {
          throw unavailable();
        }
        return result(existingAttachment, true);
      }
      if (attachments.length >= MAX_MESSAGE_ATTACHMENTS)
        throw Object.assign(Error('This message already has five attachments.'), { status: 409 });
      let attachment;
      try {
        attachment = collector.readExplicit({ outputDir: root, filePath: target });
      } catch {
        throw unavailable();
      }
      if (!attachment?.id || attachment.sourcePath !== target) throw unavailable();
      // Store.update also derives attachment visibility receipts. Keep this
      // synchronous message transaction whole if its durable save fails.
      const previous = { ...message };
      try {
        store.update(message.id, { attachments: [...attachments, attachment] });
      } catch {
        for (const key of Object.keys(message))
          if (!Object.hasOwn(previous, key)) Reflect.deleteProperty(message, key);
        Object.assign(message, previous);
        throw Object.assign(
          Error('The output snapshot could not be saved. Try again after checking storage.'),
          { status: 500 },
        );
      }
      onChange();
      return result(attachment, false);
    },
  };
}

export function installOutputLinkRecoveryRoute(app: Express, options: OutputLinkRecoveryOptions) {
  const recovery = createOutputLinkRecovery(options);
  app.post('/api/messages/:id/output-link/resolve', (req, res) => {
    try {
      res.json(recovery.resolve(req.params.id, req.body));
    } catch (error) {
      const status =
        isRecord(error) &&
        typeof error.status === 'number' &&
        [400, 404, 409, 500].includes(error.status)
          ? error.status
          : null;
      res.status(status ?? 400).json({
        error:
          status !== null
            ? errorMessage(error)
            : 'The referenced output file could not be restored.',
      });
    }
  });
  return recovery;
}
