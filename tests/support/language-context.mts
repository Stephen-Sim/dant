import {
  TaskStatus,
  ConnectionStatus,
  SubmissionStatus,
  ServiceUpdateStatus,
  ComputerControlStatus,
  ProvisioningStatus,
  RecordingDraftStatus,
} from '../../src/contracts/states.mts';
import { MAX_ATTACHMENT_BYTES } from '../../src/config/limits.mts';
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
} from '../../src/i18n/languages.mts';
import { translate, localizeMessages } from '../../src/i18n/i18n.mts';
// VM fixtures run selected UI functions without loading browser assets.
export const languageContext = {
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
