import { NATIVE_PROTOCOL, MAX_PORT, apiPath } from '../../ui/platform/native-protocol.mts';
import { COMPUTER_RESOURCES } from '../../ui/computer/resource-config.mts';
import { DEFAULT_SSH_PORT } from '../../ui/computer/connection-config.mts';
import {
  appearanceDefaults,
  appearanceFontRanges,
  MAX_APPEARANCE_IMPORT_BYTES,
} from '../../ui/settings/appearance-preferences.mts';
import {
  TaskStatus,
  ConnectionStatus,
  SubmissionStatus,
  ServiceUpdateStatus,
  ComputerControlStatus,
  ProvisioningStatus,
  RecordingDraftStatus,
} from '../../ui/shared/states.mts';
import { MAX_ATTACHMENT_BYTES } from '../../ui/files/attachment-limits.mts';
import { en, zh } from '../../ui/i18n/interface-copy.mts';
import { escapeHtml } from '../../ui/shared/html.mts';
import {
  requestError,
  isRecord,
  attachmentSnapshot,
  hasValue,
} from '../../ui/shared/contracts.mts';
import { requiredData, formInput, formSelect, serviceStatusLabel } from '../../ui/app/controls.mts';
import {
  languages,
  isLanguage,
  normalizeLanguage,
  languageInfo,
  languageForWorker,
} from '../../ui/i18n/languages.mts';
import { translate, localizeMessages } from '../../ui/i18n/messages.mts';
import { formatMessageTime } from '../../ui/chat/render-cache.mts';
import { messageHistoryScope } from '../../ui/chat/message-window.mts';
import { callCaptionScope } from '../../ui/call/call-caption-preferences.mts';
// VM fixtures run selected UI functions without loading browser assets.
export const languageContext = {
  COMPUTER_RESOURCES,
  DEFAULT_SSH_PORT,
  NATIVE_PROTOCOL,
  MAX_PORT,
  apiPath,
  appearanceDefaults,
  appearanceFontRanges,
  MAX_APPEARANCE_IMPORT_BYTES,
  TaskStatus,
  ConnectionStatus,
  SubmissionStatus,
  ServiceUpdateStatus,
  ComputerControlStatus,
  ProvisioningStatus,
  RecordingDraftStatus,
  MAX_ATTACHMENT_BYTES,
  en,
  zh,
  esc: escapeHtml,
  requestError,
  isRecord,
  attachmentSnapshot,
  hasValue,
  requiredData,
  formInput,
  formSelect,
  serviceStatusLabel,
  languages,
  isLanguage,
  normalizeLanguage,
  languageInfo,
  languageForWorker,
  translate,
  localizeMessages,
  formatMessageTime,
  messageHistoryScope,
  callCaptionScope,
  loadLanguage: async () => {},
};

/** Supply real imported dependencies to isolated browser entrypoint fixtures. */
export function uiFixtureContext<T extends object>(context: T) {
  return Object.assign(context, languageContext, {
    currentState() {
      const state: unknown = Reflect.get(context, 'state');
      if (!isRecord(state)) throw Error('Application state is unavailable');
      return state;
    },
  });
}
