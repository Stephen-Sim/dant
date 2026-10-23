import type { ReadMessage } from './chat/read-state.mts';
import {
  TaskStatus,
  ConnectionStatus,
  SubmissionStatus,
  ServiceUpdateStatus,
  ComputerControlStatus,
  ProvisioningStatus,
  RecordingDraftStatus,
} from './shared/states.mts';
import { MAX_ATTACHMENT_BYTES } from './files/attachment-limits.mts';
import { COMPUTER_RESOURCES } from './computer/resource-config.mts';
import { DEFAULT_SSH_PORT } from './computer/connection-config.mts';
import { NATIVE_PROTOCOL, MAX_PORT, apiPath } from './platform/native-protocol.mts';
import {
  appearanceDefaults,
  appearanceFontRanges,
  MAX_APPEARANCE_IMPORT_BYTES,
} from './settings/appearance-preferences.mts';
import type { ProgressMessage } from './work/progress-snapshot.mts';
import { requiredData, formInput, formSelect, serviceStatusLabel } from './app/controls.mts';
import {
  readAppState,
  read,
  attachment,
  telegram,
  pairing,
  login,
  provisioning,
  profiles,
  providerInfo,
  fonts,
  voices,
  callStart,
  sendResult,
} from './app/application-state.mts';
import type { CallStartResult, SendResult, VoiceCatalogue } from './app/application-types.ts';
import { objectOf, optional, numberValue } from './shared/validation.mts';
import { escapeHtml as esc } from './shared/html.mts';
import {
  isRecord,
  requestError,
  LocalRequestError,
  attachmentSnapshot,
  hasValue,
} from './shared/contracts.mts';
import type {
  ApiOptions,
  Attachment,
  UiModal,
  VmSettings,
  Timer,
  Interval,
} from './shared/contracts.mts';
import type {
  AppState,
  AppSettings,
  ProvisioningState,
  VmProfiles,
  VmProviderInfo,
  TelegramStatus,
  TelegramPairing,
  LoginDetails,
  FontInventory,
  RecordingDraft,
  DraftRecorder,
  ConversationFile,
} from './app/application-types.ts';
import type { ProgressItem } from './work/work-progress.mts';
import type { TaskStatusValue } from './shared/states.mts';
import type { TransportEvent } from './platform/transport.mts';
import { en, zh } from './i18n/interface-copy.mts';
import { languages, isLanguage, normalizeLanguage, languageInfo } from './i18n/languages.mts';
import { loadLanguage } from './i18n/localization.mts';
import { translate } from './i18n/messages.mts';
import './style.css';
import {
  createElement,
  MessageCircle,
  Monitor,
  Settings,
  Brain,
  ArrowUp,
  Plus,
  Phone,
  Mic,
  Square,
  X,
  ArrowLeft,
  Reply,
  Smile,
  Check,
  CheckCheck,
  Paperclip,
  Volume2,
  Clock,
  Minimize2,
  Maximize2,
  MicOff,
  LogIn,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  Download,
  Pause,
  Play,
  MoreHorizontal,
  ChevronDown,
  FileText,
  ArrowDown,
  Search,
  Puzzle,
} from 'lucide';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { reconcile } from './shared/dom.mts';
import { createChatScroll } from './chat/chat-scroll.mts';
import { createMarkdownCache, formatMessageTime } from './chat/render-cache.mts';
import { createMessageWindow, messageHistoryScope } from './chat/message-window.mts';
import { createTransport } from './platform/transport.mts';
import { createMessageSubmissions, createCallStops } from './chat/pending.mts';
import { SpeechHelper } from './platform/speech.mts';
import {
  createAppearance,
  exportAppearance as serializeAppearance,
  importAppearance as parseAppearance,
} from './settings/appearance.mts';
import { createCallDuration, formatCallDuration } from './call/call-duration.mts';
import { createCallSubtitles } from './call/call-subtitles.mts';
import {
  callCaptionScope,
  createCallCaptionPreferences,
} from './call/call-caption-preferences.mts';
import { createFloatingCall } from './call/floating-call.mts';
import { createDownloads } from './files/downloads.mts';
import { bindAttachmentImages } from './files/attachment-images.mts';
import { bindMessageAttachmentLink } from './files/attachment-links.mts';
import { telegramConnectionError, telegramDeliveryNotice } from './chat/telegram-delivery.mts';
import { canPreviewFile, createFilePreview } from './files/file-preview.mts';
import { createWorkDisclosures } from './work/work-disclosures.mts';
import { createSchedules } from './schedules/schedules.mts';
import {
  workProgress,
  renderWorkEntry,
  renderWorkSummary,
  renderActiveWork,
  renderVoiceWorkHistory,
  renderWorkTaskHistory,
  renderWorkPriority,
  updateWorkTimers,
} from './work/work-progress.mts';
import { createProgressActions } from './work/progress-actions.mts';
import { createProgressPanel } from './work/progress-panel.mts';
import { createWorkspaceLayout } from './work/workspace-layout.mts';
import { createNativeCallOverlay } from './platform/native-call-overlay.mts';
import { createNativeTray } from './platform/native-tray.mts';
import { createTextEditor } from './platform/text-editor.mts';
import { defaultReactions } from './chat/reactions.mts';
import { createManagedSettings } from './settings/managed-settings.mts';
import { createChatHistory } from './chat/chat-history.mts';
import { createChatCollections } from './chat/chat-collections.mts';
import { searchMessages } from './chat/chat-search.mts';
import { formatPresence } from './chat/presence.mts';
import { createReadVisibility } from './chat/read-state.mts';
import { createUpdates } from './settings/updates.mts';
import { createNativeUpdates } from './platform/native-updates.mts';
import { createUpdateDraft, updateDraftScope } from './settings/update-draft.mts';
import { createMemorySettings } from './settings/memory-settings.mts';
import { createVmBackups } from './settings/vm-backups.mts';
import { createRecoverySettings } from './app/recovery-settings.mts';
import { createFirstRun } from './onboarding/first-run.mts';
import './onboarding/first-run.css';
import { createSettingsNavigation } from './settings/settings-navigation.mts';
import { renderUsageSettings } from './settings/usage-settings.mts';
import { createUsageActivityController, usageActivityScope } from './settings/usage-activity.mts';
import { createTaskReplyController } from './work/task-reply.mts';
import { createTaskDetails } from './work/task-details.mts';
import packageInfo from '../package.json';
const icons = {
  MessageCircle,
  Monitor,
  Settings,
  Brain,
  ArrowUp,
  Plus,
  Phone,
  Mic,
  Square,
  X,
  ArrowLeft,
  Reply,
  Smile,
  Check,
  CheckCheck,
  Paperclip,
  Volume2,
  Clock,
  Minimize2,
  Maximize2,
  MicOff,
  LogIn,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  Download,
  Pause,
  Play,
  MoreHorizontal,
  ChevronDown,
  FileText,
  ArrowDown,
  Search,
  Puzzle,
};
const base = window.__TAURI_INTERNALS__ ? NATIVE_PROTOCOL.httpOrigin : '';
let fallbackLanguage = normalizeLanguage(localStorage.getItem('dant.language'));
let token = '',
  state: AppState | null = null,
  page = 'chat',
  showComputer = localStorage.getItem('computer') === 'true',
  replyTo: string | null = null,
  attachments: Attachment[] = [],
  screenTimer: Interval | null = null,
  screenBusy = false,
  pc: RTCPeerConnection | null = null,
  stream: MediaStream | null = null,
  audio: HTMLAudioElement | null = null,
  callMini = false,
  callMuted = false,
  recording: DraftRecorder | null = null,
  lastAssistant = new Set<string>(),
  initialized = false;
let composerDraft = '',
  vmDraft: VmSettings | null = null,
  loginDetails: LoginDetails | null = null,
  sending = false,
  uploading = 0,
  eventConnected = false,
  callStarting = false,
  callGeneration = 0,
  callTimeout: Timer | undefined,
  recordStarting = false,
  provisionDraft = {
    provider: 'auto',
    cpu: COMPUTER_RESOURCES.cpu.default,
    memoryGB: COMPUTER_RESOURCES.memoryGB.default,
    diskGB: COMPUTER_RESOURCES.diskGB.default,
    adminSudo: false,
  },
  provisionExpanded = false,
  voiceApiExpanded = false,
  voiceChoices: string[] = [],
  voiceLoadedFor = '',
  voiceError = '',
  screenURL = '',
  screenError: string | boolean = '',
  screenFailures = 0,
  unloading = false;
let chatMode = 'text',
  modal: UiModal | null = null,
  modalFocus: HTMLElement | null = null,
  emojiFor: string | null = null,
  manualVMExpanded = false,
  screenLoad: (() => Promise<void>) | null = null,
  screenAbort: AbortController | null = null,
  screenEpoch = 0,
  steerDraft = '',
  steerExpectedTurn: string | null = null;
let recordGeneration = 0,
  recordDraft: RecordingDraft | null = null,
  recordTimer: Interval | null = null;
let apiVoiceChoices: string[] = [],
  callId: string | null = null,
  callChannel: RTCDataChannel | null = null,
  callConnected = false,
  callProvider = 'subscription',
  dictating = false,
  speakingId: string | null = null,
  speechGeneration = 0,
  attachmentMenu = false;
const speech = new SpeechHelper();
const readVisibility = createReadVisibility({
  desktop: Boolean(window.__TAURI_INTERNALS__),
  onChange: () => {
    if (!unloading) updateRead();
  },
});
const callDuration = createCallDuration({ onTick: () => updateCallDuration() });
const callSubtitles = createCallSubtitles({ onChange: () => callSubtitles.update(document) });
const callCaptionPreferences = createCallCaptionPreferences({
  document,
  getState: () => state,
  getLanguage: language,
  request: api,
  connected: () => eventConnected,
  onChange: render,
  onError: toast,
});
const floatingCall = createFloatingCall({ window });
const workDisclosures = createWorkDisclosures({ getState: () => state, document });
const chatScroll = createChatScroll({
  document,
  window,
  getScope: () =>
    JSON.stringify([
      state?.conversationId ?? null,
      state?.settings?.vm?.host ?? null,
      state?.settings?.vm?.user ?? null,
      state?.settings?.vm?.port ?? null,
      state?.settings?.vm?.keyPath ?? null,
    ]),
});
const messageWindow = createMessageWindow();
const progressActions = createProgressActions({
  getModel: () => workProgress(state, { language: language(), connected: eventConnected }),
  request: taskRequest,
  render,
  toast,
  getLanguage: language,
  formatError: errorText,
  document,
  isPending: (id) => pendingActions.has('task:' + id),
});
const progressPanel = createProgressPanel({
  document,
  renderContent: renderProgress,
  title: () => t('progress'),
  closeLabel: () => t('close'),
  closeIcon: () => ico('x'),
  resizeLabel: () => t('resizeProgress'),
  onChange: render,
  onClose: () => progressActions.onClose(),
  getScope: () =>
    JSON.stringify([
      messageHistoryScope(state),
      state?.settings.vm?.knownHosts ?? null,
      state?.settings.vm?.provider ?? null,
    ]),
});
const workspaceLayout = createWorkspaceLayout({ document, window, storage: localStorage });
const nativeCallOverlay = createNativeCallOverlay({
  desktop: Boolean(window.__TAURI_INTERNALS__),
  onAction: handleNativeCallAction,
  onError: () =>
    toast(
      translate(
        language(),
        'The floating call window is temporarily unavailable.',
        '通话悬浮窗暂时不可用。',
      ),
    ),
});
const nativeTray = createNativeTray({
  desktop: Boolean(window.__TAURI_INTERNALS__),
  onProgress: openProgress,
});
const appearance = createAppearance({
  save: (values) => api('/settings', { method: 'PATCH', body: values }),
  ...(window.__TAURI_INTERNALS__
    ? {
        setNativeTheme: (theme: 'dark' | 'light' | null) =>
          import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
            getCurrentWindow().setTheme(theme),
          ),
      }
    : {}),
});
let vmProfiles: VmProfiles | null = null,
  vmProfilesBusy = false,
  vmProfilesVisible = false,
  vmProfilesError = '',
  selectedVMProfile = '',
  legacyVMDirectory = '',
  vmProviderInfo: VmProviderInfo | null = null,
  vmProvidersBusy = false,
  vmProvidersError = '';
let telegramStatus: Partial<TelegramStatus> | null = null,
  telegramLoading = false,
  telegramError = '',
  telegramPairing: TelegramPairing | null = null,
  telegramPairTimer: Timer | null = null;
let fontInventory: FontInventory | null = null,
  fontLoading = false,
  fontError = '',
  fontSearch = '',
  fontMenuOpen = false,
  appearanceAdvanced = false;
const transport = createTransport({ base, onToken: (value) => (token = value) });
const downloads = createDownloads({ base, getToken: () => token });
const textEditor = createTextEditor({
  desktop: Boolean(window.__TAURI_INTERNALS__),
  getLanguage: language,
  getToken: () => token,
  render,
  document,
});
const filePreview = createFilePreview({
  getState: () => state,
  getModal: () => modal,
  openModal,
  render,
  getToken: () => token,
  base,
  icon: (name) => ico(name),
  openExternal: (file) => textEditor.open(file),
});
const messageSubmissions = createMessageSubmissions(),
  callStops = createCallStops((id) => post('/call/stop', { callId: id }));
const managedSettings = createManagedSettings({
  getState: () => state,
  getModal: () => modal,
  request: api,
  download: (file) => downloads.save(file),
  render,
  toast,
  openModal,
  closeModal,
  document,
  connected: () => eventConnected,
  icon: (name) => ico(name),
});
const scheduledTasks = createSchedules({
  getState: () => state,
  request: api,
  render,
  toast,
  document,
  connected: () => eventConnected,
  icon: (name) => ico(name),
  timeZone: () => state?.settings?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
});
const chatCollections = createChatCollections({
  document,
  getState: () => state,
  getModal: () => modal,
  connected: () => eventConnected,
  request: api,
  render,
  toast,
  openModal,
  closeModal,
  closeMessageMenu: () => chatHistory.onClose(),
  revealMessage,
  navigate: (action) => chatScroll.navigate(action),
  openFile: (file, download) => {
    if (download) return downloads.save(file);
    if (file.type.startsWith('image/')) openModal({ type: 'image', fileId: file.id });
    else if (canPreviewFile(file)) return filePreview.open(file);
    else return downloads.save(file);
  },
  openLink: (url) =>
    window.__TAURI_INTERNALS__
      ? openExternal(url)
      : window.open(url, '_blank', 'noopener,noreferrer'),
  icon: (name) => ico(name),
});
const chatHistory = createChatHistory({
  getState: () => state,
  request: api,
  render,
  toast,
  openModal,
  closeModal,
  revealMessage,
  navigate: (action) => chatScroll.navigate(action),
  document,
  connected: () => eventConnected,
  callActive: speechBlocked,
  searchMessages,
  icon: (name) => ico(name),
  getSpeechState: (message) =>
    message.role === 'assistant' && message.kind !== 'call' && message.text
      ? {
          active: speakingId === message.id,
          disabled:
            speakingId !== message.id &&
            (speechBlocked() ||
              Boolean(recording) ||
              recordStarting ||
              message.status === 'streaming'),
        }
      : null,
  onReadAloud: (id) => readAloud(id).catch((error) => toast(errorText(error))),
  renderMetadataActions: (message) => chatCollections.renderMessageActions(message),
  renderMetadataMarkers: (message) => chatCollections.renderMarkers(message),
  onOpenMenu: () => chatCollections.onClose(),
});
const updateDraft = createUpdateDraft(),
  nativeUpdates = createNativeUpdates({
    desktop: Boolean(window.__TAURI_INTERNALS__),
    getToken: () => token,
  });
let restoringUpdateDraft = false,
  updateInstalling = false;
const appUpdates = createUpdates({
  request: api,
  version: packageInfo.version,
  getLanguage: language,
  onChange: () => {
    if (page === 'settings' && !unloading) render();
  },
  document,
  nativeUpdater: nativeUpdates,
  getInstallState: updateInstallState,
  beforeInstall: saveUpdateDraft,
  ...(window.__TAURI_INTERNALS__ ? { openExternal } : {}),
  onOpenError: (error) => toast(errorText(error)),
});
nativeUpdates
  .ready?.()
  .then(() => {
    if (page === 'settings' && !unloading) render();
  })
  .catch(() => {});
const memorySettings = createMemorySettings({
  request: api,
  getState: () => state,
  getLanguage: language,
  onChange: render,
  document,
  connected: () => eventConnected,
  renderMarkdown: md,
});
const vmBackups = createVmBackups({
  request: api,
  desktop: Boolean(window.__TAURI_INTERNALS__),
  getToken: () => token,
  getState: () => state,
  getLanguage: language,
  connected: () => eventConnected,
  onChange: render,
  toast,
  document,
});
const firstRun = createFirstRun({
  getState: () => state,
  getLanguage: language,
  request: api,
  onChange: () => {
    if (!unloading && state) render();
  },
  onCreate: async () => {
    openModal({ type: 'setup' });
    await loadVMProviders();
  },
  onExisting: useExistingComputer,
  onManual: async () => {
    manualVMExpanded = true;
    await action('computer-settings');
  },
  onBackupImport: async () => {
    await action('settings');
    settingsNavigation.select('computer', '.vm-backup-import');
    await vmBackups.openImport();
  },
});
const settingsNavigation = createSettingsNavigation({
  document,
  getLanguage: language,
  onChange: render,
  onCategory: loadSettingsCategory,
  onError: (error) => toast(errorText(error)),
});
const usageActivity = createUsageActivityController({
  document,
  onChange: render,
  getScope: () => usageActivityScope(state),
});
const taskReplies = createTaskReplyController({
  document,
  getModel: () => workProgress(state, { language: language(), connected: eventConnected }),
  getLanguage: language,
  render,
  openChat: () => {
    page = 'chat';
    chatMode = 'text';
    if (pc) callMini = true;
    attachmentMenu = false;
    closeModal();
  },
  toast,
  isPending: () =>
    sending || updateInstalling || progressActions.busy || Boolean(messageSubmissions.unknown),
});
const taskDetails = createTaskDetails({
  document,
  getState: () => state,
  getLanguage: language,
  getModal: () => modal,
  openModal,
  request: api,
  render,
  connected: () => eventConnected,
  icon: (name) => ico(name),
  onReply: (target) => taskReplies.select(target),
  onFile: (file) => {
    if (String(file.type).startsWith('image/')) openModal({ type: 'image', fileId: file.id });
    else if (canPreviewFile(file)) void filePreview.open(file);
    else
      void downloads
        .save(file)
        .catch(() =>
          toast(
            translate(
              language(),
              'Could not save the file. Check the connection and try again.',
              '文件保存失败，请检查连接后重试。',
            ),
          ),
        );
  },
  onDownload: (file) => downloads.save(file),
  onReveal: (id) => {
    if (!currentState().messages.some((message) => message.id === id)) return;
    closeModal();
    revealMessage(id);
    const target = [...document.querySelectorAll<HTMLElement>('.message[data-id]')].find(
      (element) => element.dataset.id === id,
    );
    if (target) {
      chatScroll.navigate(() => target.scrollIntoView({ block: 'center', behavior: 'auto' }));
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
    updateRead();
  },
});
let presenceTimer: Interval | undefined;
const appNode = document.querySelector<HTMLElement>('#app');
if (!appNode) throw Error('Application root is missing');
const app: HTMLElement = appNode;
const recoverySettings = createRecoverySettings({
  container: app,
  getLanguage: language,
  request: async (route, options) => {
    if (route === apiPath('/controller/settings') || route === apiPath('/updates?channel=beta')) {
      const session = await transport.json(NATIVE_PROTOCOL.paths.session);
      if (!isRecord(session) || typeof session.token !== 'string') throw Error('Invalid session');
      transport.setToken(session.token);
    }
    return transport.json(route, options);
  },
  onRetry: boot,
  openExternal,
});
document.body.insertAdjacentHTML(
  'beforeend',
  '<div id="toast" role="status" aria-live="polite"></div>',
);

function currentState(): AppState {
  if (!state) throw Error('Application state is unavailable');
  return state;
}
function language() {
  return normalizeLanguage(state?.settings?.language, fallbackLanguage);
}
const t = (value: unknown): string => {
  const key = typeof value === 'string' ? value : '';
  return translate(
    language(),
    Object.hasOwn(en, key) ? en[key as keyof typeof en] : key,
    Object.hasOwn(zh, key) ? zh[key as keyof typeof zh] : undefined,
  );
};
function errorText(cause: unknown, prefix = 'requestError'): string {
  const error = requestError(cause);
  if (error.code === 'service_update_required')
    return translate(
      language(),
      'The work computer service has not finished updating automatically. Check its status in Settings → Work computer, then try again. Your draft has been kept.',
      '工作电脑服务尚未完成自动更新，请在设置 → 工作电脑查看状态后再试；草稿已保留。',
    );
  if (error.code === 'vm_update_unconfirmed') return t('serviceUpdateUnconfirmed');
  if (/^vm_update_[a-z_]+$/.test(error.code || '')) return t('serviceUpdateError');
  const message = typeof cause === 'string' ? cause : error.message || t('messageError');
  const exact = Object.keys(zh).find(
    (key) =>
      zh[key as keyof typeof zh] === message ||
      (Object.hasOwn(en, key) && en[key as keyof typeof en] === message),
  );
  if (exact) return t(exact);
  const named = {
    NotAllowedError: 'micPermissionDenied',
    PermissionDeniedError: 'micPermissionDenied',
    NotFoundError: 'micNotFound',
    DevicesNotFoundError: 'micNotFound',
    NotReadableError: 'micBusy',
    TrackStartError: 'micBusy',
  };
  if (Object.hasOwn(named, error.name)) return t(named[error.name as keyof typeof named]);
  const telegramCode = /^Telegram rejected the request \((401|409|429)\)$/.exec(message);
  if (telegramCode)
    return (
      t(
        { 401: 'telegramTokenInvalid', 409: 'telegramBotBusy', 429: 'telegramRateLimited' }[
          (telegramCode[1] ?? '401') as '401' | '409' | '429'
        ],
      ) +
      ' (' +
      telegramCode[1] +
      ')'
    );
  if (/^VM preparation failed\b|^VM update could not confirm that work stopped\./.test(message))
    return t('serviceUpdateError');
  const known: readonly (readonly [RegExp, string])[] = [
    [
      /^Stop active work and return computer control before changing its connection$/,
      'vmConnectionBusy',
    ],
    [/^No VM connection is configured[.]/, 'vmConfigNeeded'],
    [
      /^The VM SSH (?:private key is missing or unreadable|key path is missing|key must be an existing)/,
      'vmKeyMissing',
    ],
    [/^The VM host, user or SSH port is invalid[.]/, 'vmDetailsInvalid'],
    [/^Several existing VM connections were found[.]/, 'selectVMProfile'],
    [/^A valid VM connection already exists[.]/, 'currentVMProtected'],
    [/^Invalid Telegram bot token$/, 'telegramTokenInvalid'],
    [/^Disconnect the current Telegram owner before pairing another$/, 'telegramUnpairFirst'],
    [/^Telegram.*(?:unauthorized|token is invalid|invalid.*token)/i, 'telegramTokenInvalid'],
    [/^Invalid appearance preferences?(?:: [a-zA-Z]+)?$/, 'appearanceInvalid'],
    [
      /^The computer connected, but its default response language could not be updated[.]$/,
      'responseLanguageNotUpdated',
    ],
    [/^Invalid local API route$/, 'invalidLocalRoute'],
    [/^Invalid JSON response from local service$/, 'invalidServiceResponse'],
    [/^Local API response was interrupted$/, 'responseInterrupted'],
    [/^Local API response is too large$/, 'responseTooLarge'],
    [/^The local controller is disconnected$/, 'connectionLost'],
    [
      /^The request outcome is unconfirmed[. ]|^The VM connection ended before the result was confirmed|^Check the unconfirmed message before sending again$/,
      'sendUnknownHint',
    ],
    [/^The voice call changed$|^The subscription voice call changed$/, 'callChanged'],
    [/^The (?:subscription |voice )?call is not ready$/, 'callNotReady'],
    [/^A (?:subscription )?call is already active$/, 'callAlreadyActive'],
    [/^Configure the optional voice API key first$/, 'voiceKeyRequired'],
    [/^End the (?:voice )?call before resuming/, 'resumeAfterCall'],
    [/^End the (?:voice )?call before taking control[.]?$/, 'endCallBeforeControl'],
    [
      /^Desktop control session expired|^Desktop control session expired or does not match$/,
      'sessionExpired',
    ],
    [/^The Windows speech recognition language is not installed/, 'speechLanguageMissing'],
    [/^Windows Speech is unavailable$/, 'speechUnavailable'],
    [/^Speech operation timed out$/, 'speechTimedOut'],
    [/^Read-aloud text exceeds 10000 characters/, 'speechTooLong'],
    [/^Speech cancelled$/, 'speechCancelled'],
  ];
  for (const [pattern, key] of known) if (pattern.test(message)) return t(key);
  const timeout = /^Timed out: (.+)$/.exec(message);
  if (timeout) return t('requestTimedOut') + ': ' + timeout[1];
  return t(prefix) + (language() === 'zh' ? '：' : ': ') + message;
}
async function changeLanguage(value: unknown) {
  if (!isLanguage(value) || pendingActions.has('setting:language')) return;
  pendingActions.add('setting:language');
  render();
  try {
    await loadLanguage(value);
    await api('/settings', { method: 'PATCH', body: { language: value } });
    fallbackLanguage = value;
    localStorage.setItem('dant.language', value);
    if (state) currentState().settings.language = value;
  } finally {
    pendingActions.delete('setting:language');
    render();
  }
}
function vmProviderLabel(provider: unknown) {
  return provider === 'hyperv'
    ? 'Hyper-V'
    : provider === 'vmware'
      ? 'VMware Workstation'
      : provider === 'auto'
        ? t('providerAuto')
        : t('computerSystem');
}
function reactionName(emoji: string) {
  const item = defaultReactions.find((item) => item.emoji === emoji);
  return item ? translate(language(), item.en, item.zh) : emoji;
}
function vmConfiguredProvider() {
  const vm = currentState().settings.vm || {},
    setup = currentState().provisioning;
  return vm.provider || (setup?.connection?.host === vm.host ? setup?.provider : null);
}
function vmSystemDescription() {
  const provider = vmConfiguredProvider();
  return provider === 'hyperv' || provider === 'vmware'
    ? 'Ubuntu · ' + vmProviderLabel(provider)
    : t('computerSystem');
}
function vmProviderStatus() {
  const setup: Partial<ProvisioningState> = currentState().provisioning || {};
  return {
    provider: setup.running
      ? setup.provider
      : provisionDraft.provider && provisionDraft.provider !== 'auto'
        ? provisionDraft.provider
        : vmProviderInfo?.provider || setup.provider,
    availableProviders: setup.availableProviders?.length
      ? setup.availableProviders
      : vmProviderInfo?.availableProviders || [],
  };
}
async function loadVMProviders() {
  if (vmProvidersBusy) return;
  vmProvidersBusy = true;
  vmProvidersError = '';
  render();
  try {
    vmProviderInfo = await api('/vm/providers');
  } catch (cause) {
    const error = requestError(cause);
    vmProvidersError = error.message;
  } finally {
    vmProvidersBusy = false;
    render();
  }
}
function setupStageText(current: ProvisioningState) {
  const stages = {
    'checking-vmware': 'providerChecking',
    'checking-hyper-v': 'providerChecking',
    'preparing-seed': 'guestPreparing',
    prepared: 'guestPreparing',
    'converting-image': 'diskPreparing',
    'expanding-disk': 'diskPreparing',
    'starting-vm': 'computerBooting',
    'network-repaired': 'computerNetworking',
    'downloading-image': 'imageDownloading',
    'verifying-image': 'imageVerifying',
    'extracting-image': 'imagePreparing',
    'configuring-nocloud': 'guestPreparing',
    'allocating-source-disk': 'diskPreparing',
    'converting-disk': 'diskPreparing',
    'resizing-disk': 'diskPreparing',
    'registering-vm': 'computerRegistering',
    'creating-vmx': 'computerRegistering',
    'booting-vm': 'computerBooting',
    'waiting-for-ip': 'computerNetworking',
    'guest-installing': 'installing',
  };
  return t(
    (current.stage && Object.hasOwn(stages, current.stage)
      ? stages[current.stage as keyof typeof stages]
      : undefined) || current.status,
  );
}

const subscriptionVoiceUnavailable = () =>
  state?.worker?.realtime?.subscription?.available === false;
const apiVoiceUnavailable = () =>
  state?.worker?.realtime?.api?.available === false || !voiceKeyConfigured();
const humanControl = () =>
  state?.computer
    ? state.computer.status === ComputerControlStatus.Human
    : Boolean(state?.takeover);
const computerReachable = () =>
  eventConnected &&
  Boolean(
    state &&
    (currentState().controller
      ? currentState().controller?.status === ConnectionStatus.Online &&
        currentState().controller?.cached !== true
      : currentState().worker?.status === ConnectionStatus.Online),
  );
const computerExecutorReady = () =>
  computerReachable() && currentState().worker?.status === ConnectionStatus.Online;
const callControlBusy = () =>
  Boolean(
    callStarting ||
    callStops.pending ||
    (state?.call && currentState().call?.status !== 'connected') ||
    (pc && !state?.call),
  );
const computerInputReady = () => humanControl() && computerExecutorReady() && !callControlBusy();
const callBlocksControl = () => !humanControl() && callControlBusy();
const unknownTask = (message: Pick<ProgressMessage, 'unknownOutcome' | 'submission'> | undefined) =>
  Boolean(
    message?.unknownOutcome ||
    message?.submission === SubmissionStatus.Unknown ||
    message?.submission === SubmissionStatus.Submitting,
  );
const voiceKeyConfigured = () =>
  state?.worker?.realtime?.key?.configured ??
  (state?.worker?.realtime?.provider === 'openai' && state?.worker?.realtime?.available === true);
const iconCache = new Map<string, string>();
const ico = (name: string, cls = ''): string => {
  const cacheKey = name + ':' + cls;
  if (!iconCache.has(cacheKey)) {
    const key = name.replace(/(^|-)([a-z0-9])/g, (_match: string, _dash: string, char: string) =>
      char.toUpperCase(),
    );
    const definition = Object.hasOwn(icons, key) ? icons[key as keyof typeof icons] : undefined;
    iconCache.set(
      cacheKey,
      definition
        ? createElement([
            definition[0],
            { ...definition[1], class: cls, 'aria-hidden': 'true' },
            definition[2] ?? [],
          ]).outerHTML
        : '',
    );
  }
  return iconCache.get(cacheKey) || '';
};
const button = (
  action: string,
  icon: string,
  label: string,
  cls = 'icon-btn',
  disabled: unknown = false,
) =>
  `<button ${disabled ? 'disabled aria-disabled="true" ' : ''}type="button" class="${cls}" data-action="${action}" title="${esc(label)}" aria-label="${esc(label)}">${ico(icon)}${cls.includes('text-btn') ? `<span>${esc(label)}</span>` : ''}</button>`;
const eyes = (cls = '') =>
  `<div class="eyes ${cls}" aria-hidden="true"><img src="/brand/${cls.includes('call') ? 'dant-avatar' : 'dant-logo'}.svg" alt="" draggable="false"></div>`;
function decodeApiResult(route: string, value: unknown): unknown {
  switch (route) {
    case '/state':
      return readAppState(value);
    case '/upload':
      return read(value, attachment, 'attachment response');
    case '/telegram':
    case '/telegram/config':
    case '/telegram/disconnect':
      return read(value, telegram, 'Telegram status');
    case '/telegram/pair':
      return read(value, pairing, 'Telegram pairing');
    case '/login':
      return read(value, login, 'sign-in response');
    case '/provision':
      return read(value, provisioning, 'computer preparation');
    case '/vm/providers':
      return read(value, providerInfo, 'VM provider response');
    case '/vm/profiles':
      return read(value, profiles, 'VM profiles');
    case '/fonts':
      return read(value, fonts, 'font list');
    case '/voices':
      return Array.isArray(value)
        ? read({ voices: value }, voices, 'voice list')
        : read(value, voices, 'voice list');
    case '/call':
      return read(value, callStart, 'call response');
    case '/call/connected':
      return read(
        value,
        objectOf<{ connectedAt?: number }>({ connectedAt: optional(numberValue) }),
        'call confirmation',
      );
    case '/messages':
    case '/realtime/message':
      return read(value, sendResult, 'message acknowledgement');
    default:
      return value;
  }
}
function api(route: '/state', options?: ApiOptions): Promise<AppState>;
function api(route: '/upload', options?: ApiOptions): Promise<Attachment>;
function api(route: '/fonts', options?: ApiOptions): Promise<FontInventory>;
function api(route: '/voices', options?: ApiOptions): Promise<VoiceCatalogue>;
function api(route: '/vm/providers', options?: ApiOptions): Promise<VmProviderInfo>;
function api(route: '/vm/profiles', options?: ApiOptions): Promise<VmProfiles>;
function api(route: '/telegram', options?: ApiOptions): Promise<TelegramStatus>;
function api(route: string, options?: ApiOptions): Promise<unknown>;
async function api(route: string, options: ApiOptions = {}): Promise<unknown> {
  if (!(options.body instanceof FormData))
    return decodeApiResult(route, await transport.json(apiPath(route), options));
  const response = await fetch(base + apiPath(route), {
    method: options.method ?? 'GET',
    body: options.body,
    headers: { 'X-Dant-Token': token, ...options.headers },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
  });
  const body: unknown = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    const error = new LocalRequestError(
      isRecord(body) && typeof body.error === 'string' ? body.error : t('messageError'),
    );
    error.status = response.status;
    error.unknownOutcome = isRecord(body) && body.unknownOutcome === true;
    if (isRecord(body) && typeof body.code === 'string' && /^[a-z_]{1,64}$/.test(body.code))
      error.code = body.code;
    throw error;
  }
  return decodeApiResult(route, body);
}
function post(
  route: '/telegram/config' | '/telegram/disconnect',
  body?: unknown,
): Promise<TelegramStatus>;
function post(route: '/telegram/pair', body?: unknown): Promise<TelegramPairing>;
function post(route: '/login', body?: unknown): Promise<LoginDetails>;
function post(route: '/provision', body?: unknown): Promise<ProvisioningState>;
function post(route: '/call', body?: unknown): Promise<CallStartResult>;
function post(route: '/call/connected', body?: unknown): Promise<{ connectedAt?: number }>;
function post(route: '/messages' | '/realtime/message', body?: unknown): Promise<SendResult>;
function post(route: string, body?: unknown): Promise<unknown>;
function post(route: string, body: unknown = {}): Promise<unknown> {
  return api(route, { method: 'POST', body });
}
function updateInstallState() {
  return {
    ...state,
    mode: eventConnected && state?.mode === 'vm-controller' ? 'controller' : 'offline',
    call: Boolean(pc || callStarting || state?.call || callStops.pending),
    unsafeLocalInput: Boolean(
      recording ||
      recordStarting ||
      dictating ||
      recordDraft ||
      sending ||
      uploading ||
      messageSubmissions.unknown ||
      callStarting ||
      callStops.pending,
    ),
  };
}
async function saveUpdateDraft() {
  const current = updateInstallState();
  if (updateInstalling || current.mode !== 'controller' || current.unsafeLocalInput)
    throw Error('Finish pending input or connection changes before installing.');
  const draft = {
    text: document.querySelector<HTMLTextAreaElement>('#composer')?.value ?? composerDraft,
    replyTo,
    attachments,
    ...(taskReplies.target ? { workReply: taskReplies.target } : {}),
  };
  updateInstalling = true;
  render();
  try {
    const receipt = await updateDraft.save(state, draft);
    return () => {
      updateInstalling = false;
      updateDraft.discard(receipt);
      if (!unloading) render();
    };
  } catch (cause) {
    const error = requestError(cause);
    updateInstalling = false;
    if (!unloading) render();
    throw error;
  }
}
async function restoreUpdateDraft() {
  if (restoringUpdateDraft || !updateDraftScope(state)) return;
  restoringUpdateDraft = true;
  const scope = updateDraftScope(state);
  try {
    const draft = await updateDraft.take(state, {
      occupied: Boolean(
        (document.querySelector<HTMLTextAreaElement>('#composer')?.value ?? composerDraft) ||
        replyTo ||
        attachments.length ||
        taskReplies.selected,
      ),
    });
    if (
      !draft ||
      scope !== updateDraftScope(state) ||
      (document.querySelector<HTMLTextAreaElement>('#composer')?.value ?? composerDraft) ||
      replyTo ||
      attachments.length ||
      taskReplies.selected
    )
      return;
    composerDraft = draft.text;
    replyTo = draft.replyTo;
    attachments = draft.attachments;
    if (draft.workReply) taskReplies.restore(draft.workReply);
    const input = document.querySelector<HTMLTextAreaElement>('#composer');
    if (input) input.value = composerDraft;
  } finally {
    restoringUpdateDraft = false;
  }
}
let toastTimer: Timer | undefined;
function toast(text: string) {
  const box = document.querySelector<HTMLElement>('#toast');
  if (!box) return;
  box.textContent = text;
  box.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('visible'), 6500);
}
const markdownCache = createMarkdownCache((text) =>
  DOMPurify.sanitize(marked.parse(text, { breaks: true, async: false }), {
    ALLOW_DATA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: [
      'img',
      'iframe',
      'style',
      'form',
      'input',
      'video',
      'button',
      'textarea',
      'select',
      'audio',
    ],
    FORBID_ATTR: ['style'],
  }),
);
function md(text: string): string {
  return markdownCache.render(text || '');
}
function render() {
  chatScroll.capture();
  progressPanel.capture();
  memorySettings.setVisible(page === 'memory');
  workDisclosures.capture();
  settingsNavigation.sync(page === 'settings');
  vmBackups.setVisible(
    page === 'settings' &&
      (settingsNavigation.isVisible('history') || settingsNavigation.isVisible('computer')),
    settingsNavigation.isVisible('computer') ? 'import' : 'backups',
  );
  appUpdates.setVisible(page === 'settings' && settingsNavigation.isVisible('about'));
  modal = managedSettings.syncModal(modal, page);
  modal = filePreview.syncModal(modal);
  if (typeof taskDetails !== 'undefined') taskDetails.syncModal(modal);
  appearance.sync(currentState().settings);
  const composer = document.querySelector<HTMLTextAreaElement>('#composer');
  if (composer) composerDraft = composer.value;
  const status = !eventConnected
    ? 'offline'
    : humanControl()
      ? 'takeover'
      : currentState().active
        ? 'working'
        : currentState().worker.status;
  document.documentElement.lang = languageInfo(language()).locale;
  document.documentElement.dir = languageInfo(language()).direction;
  const template = document.createElement('template');
  template.innerHTML = `${renderRail()}<main class="${page === 'chat' ? 'chat-main' : 'settings-main'}">${renderHeader(status)}${page === 'chat' ? `<div class="workspace ${showComputer ? 'computer-visible' : ''} ${progressPanel.visible ? 'progress-visible' : ''}" data-key="workspace"><section class="conversation" data-key="conversation">${renderCall()}${chatMode === 'voice' && !pc && !callStarting ? renderCallReady() : renderChat()}</section>${progressPanel.render()}${showComputer ? renderComputer() : ''}</div>` : ['skills', 'schedules'].includes(page) ? `<div class="full-page skills-full-page" data-key="page-${page}">${page === 'skills' ? managedSettings.renderSkillPage() : renderSchedules()}</div>` : `<div class="full-page" data-key="page-${page}"><div class="settings-stack">${page === 'settings' ? renderSettings() : renderMemory()}</div></div>`}</main><input type="file" id="file-input" hidden multiple>${renderModal()}`;
  reconcile(app, template.content, { preserveChildren: settingsNavigation.preservePanelChildren });
  bind();
  resizeComposer();
  for (const node of app.querySelectorAll<HTMLButtonElement>(':scope > nav,:scope > main'))
    node.toggleAttribute('inert', updateInstalling);
  if (updateInstalling) {
    const overlay = document.createElement('div');
    overlay.className = 'update-install-lock';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.textContent = translate(
      language(),
      'Starting the installer. Please wait…',
      '正在启动安装程序，请稍候…',
    );
    app.append(overlay);
  }
  floatingCall.sync(document.querySelector<HTMLElement>('.call-view.mini'), {
    bounds: app,
    anchor: document.querySelector<HTMLElement>('.conversation'),
    callKey:
      currentState().call?.id ||
      callId ||
      (pc || callStarting || callStops.pending
        ? callDuration.snapshot.callId || 'connecting'
        : null),
  });
  publishCallOverlay();
  nativeTray.sync({
    ...currentState(),
    ...(eventConnected
      ? currentState().controller
        ? { controller: currentState().controller! }
        : {}
      : {
          controller: {
            ...currentState().controller,
            status: ConnectionStatus.Offline,
            cached: true,
          },
        }),
  });
  chatScroll.restore();
  positionReactionMenus();
  updateRead();
  restartScreen();
}
function openProgress() {
  managedSettings.onClose(modal);
  chatHistory.onClose();
  chatCollections.onClose();
  modal = null;
  modalFocus = null;
  emojiFor = null;
  page = 'chat';
  chatMode = 'text';
  if (pc) callMini = true;
  progressPanel.open();
}
function renderRail() {
  const unread = unreadMessages().length;
  return `<nav class="rail" aria-label="dant"><button type="button" class="brand" data-action="chat" title="dant" aria-label="${esc(t('chat') + (unread ? ' · ' + unreadLabel(unread) : ''))}" ${page === 'chat' ? 'aria-current="page"' : ''}>${eyes('small')}<span class="unread-badge" data-unread-count="${unread}" aria-hidden="true" ${unread ? '' : 'hidden'}>${unread > 99 ? '99+' : unread}</span></button><button type="button" class="icon-btn rail-skills ${page === 'skills' ? 'selected' : ''}" data-action="skills" title="${t('skills')}" aria-label="${t('skills')}" ${page === 'skills' ? 'aria-current="page"' : ''}>${ico('puzzle')}</button><button type="button" class="icon-btn rail-schedules ${page === 'schedules' ? 'selected' : ''}" data-action="schedules" title="${t('schedules')}" aria-label="${t('schedules')}" ${page === 'schedules' ? 'aria-current="page"' : ''}>${ico('clock')}</button><div class="rail-bottom">${button('settings', 'settings', t('settings'), 'icon-btn ' + (page === 'settings' ? 'selected' : ''))}</div></nav>`;
}
function renderHeader(_status: string) {
  const presence = currentPresence(),
    settingsPage = page !== 'chat',
    title =
      page === 'skills'
        ? t('skills')
        : page === 'settings'
          ? t('settingsTitle')
          : page === 'memory'
            ? t('memoryTitle')
            : t('schedules');
  return `<header class="app-header">${settingsPage ? `<div class="settings-header">${button('chat', 'arrow-left', t('backChat'), 'text-btn back-button')}<h1>${title}</h1></div>` : `<div class="identity"><strong>dant</strong><span class="presence-status" title="${esc(presence.title)}"><i data-presence-dot class="status-dot ${presence.active ? 'working' : presence.online ? 'online' : 'offline'}"></i><span data-presence-label>${esc(presence.label)}</span><span data-presence-detail ${presence.detail ? '' : 'hidden'}> · ${esc(presence.detail)}</span></span></div>`}<div class="header-actions">${settingsPage ? (pc || currentState().call || callStops.pending ? button('hangup', 'phone', t('hangup'), 'icon-btn hangup-header') : '') : `${button('voice-mode', 'phone', t('voiceMode'), 'icon-btn mode-button ' + (chatMode === 'voice' ? 'selected' : ''))}${renderWorkEntry(workProgress(state, { language: language(), connected: eventConnected }), ico('clock'))}${button('computer', 'monitor', t('computer'), 'text-btn header-computer ' + (showComputer ? 'selected' : ''))}${button('details', 'more-horizontal', t('details'))}${chatCollections.renderMenu()}`}</div></header>`;
}
function currentPresence() {
  return formatPresence(
    {
      ...currentState(),
      ...(eventConnected
        ? currentState().controller
          ? { controller: currentState().controller! }
          : {}
        : {
            controller: {
              ...currentState().controller,
              status: ConnectionStatus.Offline,
              cached: true,
            },
          }),
      callActiveNow:
        !!pc &&
        callConnected &&
        pc.connectionState === 'connected' &&
        callChannel?.readyState === 'open',
    },
    language(),
  );
}
function chatSearchLabel() {
  return translate(language(), 'Search chat', '搜索聊天');
}
function unreadAssistant(message: ReadMessage | undefined) {
  const visibleAttachmentIds = message?.visibleAttachmentIds;
  const unseenAttachment =
    Array.isArray(visibleAttachmentIds) &&
    (message?.attachments || []).some(
      (file) => typeof file?.id === 'string' && !visibleAttachmentIds.includes(file.id),
    );
  // Read receipts describe the displayed message, including a retained partial
  // reply. They do not complete its task; live streaming still waits to settle.
  return (
    message?.role === 'assistant' &&
    message.kind !== 'call' &&
    message.status !== 'streaming' &&
    message.read !== true &&
    (unseenAttachment || (!message.receipt?.readAt && !message.readAt && !message.visibleAt))
  );
}
function unreadMessages() {
  return (state?.messages || []).filter(unreadAssistant);
}
function unreadLabel(count: number) {
  return language() === 'en'
    ? count + ' unread ' + (count === 1 ? 'message' : 'messages')
    : count + ' 条未读消息';
}
function renderAssistantReadState(message: ReadMessage) {
  return message.role === 'assistant' && message.kind !== 'call' && message.status !== 'streaming'
    ? `<span class="message-read-state" data-read-state="${unreadAssistant(message) ? 'unread' : 'read'}">${unreadAssistant(message) ? translate(language(), 'Unread', '未读') : t('read')}</span>`
    : '';
}
function renderUnreadControl() {
  const count = unreadMessages().length;
  return count
    ? `<button type="button" class="unread-jump" data-first-unread title="${translate(language(), 'Jump to first unread message', '跳到第一条未读消息')}" aria-label="${esc(unreadLabel(count))}">${ico('arrow-down')}<span>${esc(unreadLabel(count))}</span></button>`
    : '';
}
function revealMessage(id?: string) {
  page = 'chat';
  chatMode = 'text';
  if (speechBlocked()) callMini = true;
  if (id) messageWindow.reveal(id, currentState().messages, messageHistoryScope(state));
  render();
}
function updatePresence() {
  if (!state) return;
  const presence = currentPresence(),
    label = document.querySelector<HTMLButtonElement>('[data-presence-label]'),
    detail = document.querySelector<HTMLButtonElement>('[data-presence-detail]'),
    dot = document.querySelector<HTMLButtonElement>('[data-presence-dot]');
  if (label) label.textContent = presence.label;
  if (detail) {
    detail.textContent = presence.detail ? ' · ' + presence.detail : '';
    detail.hidden = !presence.detail;
  }
  if (dot)
    dot.className =
      'status-dot ' + (presence.active ? 'working' : presence.online ? 'online' : 'offline');
  const status = document.querySelector<HTMLElement>('.presence-status');
  if (status) status.title = presence.title;
}
function startPresenceTicker() {
  clearInterval(presenceTimer);
  presenceTimer = setInterval(() => {
    updatePresence();
    updateWorkTimers(document);
    const expiring = document.querySelector<HTMLElement>(
        '.work-progress-body [data-progress-expires-at]',
      ),
      expiresAt = Number(expiring?.dataset.progressExpiresAt);
    if (Number.isSafeInteger(expiresAt) && expiresAt > 0 && Date.now() >= expiresAt) render();
  }, 30000);
}
function recordingSeconds() {
  const draft = recordDraft;
  return Math.max(
    0,
    Math.floor(
      ((draft?.elapsedMs || 0) +
        (draft?.status === RecordingDraftStatus.Recording ? Date.now() - draft.startedAt : 0)) /
        1000,
    ),
  );
}
function recordingTime() {
  const seconds = recordingSeconds();
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
function renderVoiceRecorder() {
  if (!recordDraft && !recordStarting) return '';
  const draft = recordDraft,
    paused = draft?.status === RecordingDraftStatus.Paused,
    ready = draft?.status === RecordingDraftStatus.Ready,
    busy = !!draft?.busy,
    unknown = messageSubmissions.unknown?.kind === 'voice',
    preparing = recordStarting || draft?.status === RecordingDraftStatus.Finishing;
  return `<section class="voice-message-recorder" data-key="voice-message-recorder" aria-label="${t('recordAudio')}"><button type="button" class="icon-btn" data-action="cancel-record" title="${t('cancelRecording')}" aria-label="${t('cancelRecording')}" ${busy || unknown ? 'disabled' : ''}>${ico('x')}</button><div class="voice-recording-content"><div class="voice-recording-state"><i class="voice-recording-dot ${paused || ready ? 'paused' : ''}" aria-hidden="true"></i><span>${t(busy ? 'voiceSending' : preparing ? 'recordStarting' : paused ? 'recordPaused' : ready ? 'voicePreview' : 'recording')}</span><time data-record-duration>${recordingTime()}</time></div>${draft?.previewURL && (paused || ready) ? `<audio data-key="voice-preview-${draft.generation}" controls preload="metadata" src="${esc(draft.previewURL)}" aria-label="${t('voicePreview')}"></audio>` : ''}</div>${draft && !ready ? `<button type="button" class="icon-btn voice-record-pause" data-action="pause-record" title="${t(paused ? 'resumeRecording' : 'pauseRecording')}" aria-label="${t(paused ? 'resumeRecording' : 'pauseRecording')}" ${busy || preparing ? 'disabled' : ''}>${ico(paused ? 'play' : 'pause')}</button>` : ''}<button type="button" class="send-btn voice-send-btn" data-action="send-voice" title="${t('sendVoice')}" aria-label="${t('sendVoice')}" ${!draft || busy || sending || uploading || preparing || unknown || !eventConnected || speechBlocked() ? 'disabled' : ''}>${ico('arrow-up')}</button></section>`;
}
function renderChat() {
  return `${chatCollections.renderPinnedBar()}${currentState().settings?.showWorkSummary === true ? renderWorkSummary(workProgress(state, { language: language(), connected: eventConnected })) : ''}<div id="messages" class="messages">${messageWindow.control(currentState().messages, messageHistoryScope(state), language())}<div class="message-column" data-key="message-column">${currentState().messages.length ? renderMessages() : firstRun.render() || `<div class="welcome">${eyes('hero')}<h1>${t('hello')}</h1><p>${t('intro')}</p>${currentState().worker.status !== ConnectionStatus.Online ? `<button type="button" class="text-btn" data-action="computer-settings">${t('setup')}</button><small>${t('setupHint')}</small>` : ''}</div>`}</div></div><div class="composer-wrap" data-key="composer-wrap">${renderUnreadControl()}${managedSettings.renderRequests()}${taskReplies.render()}${replyTo ? `<div class="reply-preview" data-key="reply-preview"><div><small>${t('reply')} ${currentState().messages.find((message) => message.id === replyTo)?.role === 'assistant' ? 'dant' : t('you')}</small><span>${esc((currentState().messages.find((message) => message.id === replyTo)?.text || '').slice(0, 180))}</span></div>${button('cancel-reply', 'x', t('close'))}</div>` : ''}${attachments.length ? `<div class="attachment-chips" data-key="attachments">${attachments.map(renderDraftAttachment).join('')}</div>` : ''}${renderUnconfirmedMessage()}${renderVoiceRecorder()}<form id="message-form" class="composer-box" ${recordDraft || recordStarting ? 'hidden' : ''}><textarea id="composer" rows="1" placeholder="${t('placeholder')}" aria-label="${t('placeholder')}">${esc(composerDraft)}</textarea><div class="composer-tools">${renderAttachmentOptions()}<button type="button" class="icon-btn" data-action="record" title="${t('recordAudio')}" aria-label="${t('recordAudio')}" ${speechBlocked() || dictating || recordStarting || recordDraft ? 'disabled' : ''}>${ico('mic')}</button>${currentState().active || currentState().queue?.length ? button('stop', 'square', t('stop')) : ''}<button class="send-btn" type="submit" title="${t('send')}" aria-label="${t('send')}" ${sending || uploading || recording || recordStarting || recordDraft || !eventConnected ? 'disabled' : ''}>${ico('arrow-up')}</button></div></form>${uploading ? `<small class="composer-status">${t('uploading')}</small>` : dictating ? `<small class="composer-status">${t('dictating')}</small>` : speakingId ? `<small class="composer-status">${t('reading')} <button type="button" class="text-link" data-action="speech-stop">${t('stop')}</button></small>` : ''}</div>`;
}
function renderDraftAttachment(file: Attachment) {
  return `<span class="${String(file.type || '').startsWith('audio/') ? 'draft-audio' : ''}" data-id="${esc(file.id)}">${ico(String(file.type || '').startsWith('audio/') ? 'mic' : 'paperclip')}<span>${esc(file.name)}</span>${String(file.type || '').startsWith('audio/') ? `<audio controls preload="metadata" src="${esc(fileURL(file))}" aria-label="${esc(file.name)}"></audio>` : ''}<button type="button" data-remove="${esc(file.id)}" aria-label="${t('close')}">×</button></span>`;
}
function renderAttachmentOptions() {
  return `<div class="attachment-control"><button type="button" class="icon-btn" data-action="attach-menu" aria-haspopup="menu" aria-expanded="${attachmentMenu}" title="${t('attachOptions')}" aria-label="${t('attachOptions')}">${ico('paperclip')}</button>${attachmentMenu ? `<div class="attachment-menu" role="menu"><button type="button" role="menuitem" data-action="attach">${ico('paperclip')}${t('attach')}</button><button type="button" role="menuitem" data-action="dictate" ${!dictating && (speechBlocked() || recording || recordStarting) ? 'disabled' : ''}>${ico(dictating ? 'square' : 'file-text')}${t(dictating ? 'stopSpeech' : 'dictate')}</button></div>` : ''}</div>`;
}
function speechBlocked() {
  return !!pc || callStarting || !!state?.call || callStops.pending;
}
async function stopSpeech() {
  speechGeneration++;
  dictating = false;
  speakingId = null;
  await speech.stop();
  if (state && !unloading) render();
}
async function toggleDictation() {
  if (dictating) {
    await stopSpeech();
    return;
  }
  if (speechBlocked()) throw Error(t('speechDuringCall'));
  if (recording || recordStarting) throw Error(t('finishRecording'));
  const generation = ++speechGeneration;
  dictating = true;
  speakingId = null;
  attachmentMenu = false;
  render();
  try {
    const text = await speech.dictate(currentState().settings.language);
    if (generation !== speechGeneration || unloading || speechBlocked()) return;
    if (!String(text || '').trim()) {
      toast(t('emptyDictation'));
      return;
    }
    const current = document.querySelector<HTMLTextAreaElement>('#composer'),
      draft = current?.value ?? composerDraft;
    composerDraft = draft + (draft && !/\s$/.test(draft) ? ' ' : '') + String(text).trim();
    if (current) current.value = composerDraft;
    render();
    document.querySelector<HTMLTextAreaElement>('#composer')?.focus({ preventScroll: true });
  } catch (cause) {
    const error = requestError(cause);
    if (generation === speechGeneration && !unloading) toast(errorText(error));
  } finally {
    if (generation === speechGeneration) {
      dictating = false;
      if (!unloading) render();
    }
  }
}
function spokenText(text: string) {
  const node = document.createElement('div');
  node.innerHTML = md(text).replace(/<\/(?:p|li|pre|h[1-6])>|<br\s*\/?>/gi, '\n');
  return (node.textContent || '').trim();
}
async function readAloud(id: string) {
  if (speakingId === id) {
    await stopSpeech();
    return;
  }
  if (speechBlocked()) throw Error(t('speechDuringCall'));
  if (recording || recordStarting) throw Error(t('finishRecording'));
  const message = currentState().messages.find(
    (item) => item.id === id && item.role === 'assistant',
  );
  if (!message?.text) return;
  const generation = ++speechGeneration;
  dictating = false;
  speakingId = id;
  render();
  try {
    await speech.speak(spokenText(message.text), currentState().settings.language);
  } catch (cause) {
    const error = requestError(cause);
    if (generation === speechGeneration && !unloading) toast(errorText(error));
  } finally {
    if (generation === speechGeneration) {
      speakingId = null;
      if (!unloading) render();
    }
  }
}
const fileURL = (file: Attachment) =>
  base + apiPath('/files/' + encodeURIComponent(file.id)) + '?token=' + encodeURIComponent(token);
function formatTime(time: unknown, full = false) {
  const value = messageDate(time);
  if (!value) return '';
  return formatMessageTime(value, languageInfo(language()).locale, full);
}
function renderAttachment(file: Attachment) {
  const url = fileURL(file),
    type = String(file.type || '');
  if (type.startsWith('image/'))
    return `<button type="button" class="image-attachment" data-preview="${esc(file.id)}" data-image-state="loading" aria-busy="true" aria-label="${esc(file.name)}"><img class="attachment-image" src="${url}" alt="${esc(file.name)}" loading="lazy" decoding="async"><span class="attachment-image-loading" aria-hidden="true">${translate(language(), 'Loading image…', '正在加载图片…')}</span><span class="attachment-image-error" aria-hidden="true">${translate(language(), 'Image unavailable', '图片暂不可用')}</span></button>`;
  if (type.startsWith('audio/'))
    return `<audio controls preload="metadata" src="${url}" aria-label="${esc(file.name)}"></audio>`;
  const preview = canPreviewFile(file),
    view = translate(language(), 'View', '查看'),
    extension = /\.([a-z0-9]{1,12})$/i.exec(String(file.name || ''))?.[1]?.toUpperCase(),
    size = Math.max(1, Math.round((file.size || 0) / 1024)) + ' KB';
  return `<div class="file-attachment"><button type="button" class="file-card" ${preview ? 'data-file-preview' : 'data-download'}="${esc(file.id)}" aria-label="${preview ? view : t('download')} ${esc(file.name)}">${ico('file-text')}<span class="file-description"><span class="file-attachment-name" title="${esc(file.name)}">${esc(file.name)}</span><small class="file-attachment-meta">${extension ? esc(extension) + ' · ' : ''}${size}</small></span>${preview ? `<span class="file-view-label">${view}</span>` : ''}</button><button type="button" class="icon-btn file-download" data-download="${esc(file.id)}" title="${t('download')} ${esc(file.name)}" aria-label="${t('download')} ${esc(file.name)}">${ico('download')}</button></div>`;
}
function renderAttachments(files: readonly Attachment[] | undefined) {
  return files?.length
    ? `<div class="attachment-list ${files.some((file) => !String(file.type || '').startsWith('audio/')) ? 'attachment-list-wide' : ''}">${files.map(renderAttachment).join('')}</div>`
    : '';
}
function messageDate(time: unknown): Date | null {
  if (
    (typeof time !== 'number' && typeof time !== 'string') ||
    (typeof time === 'string' && !time.trim())
  )
    return null;
  const value = new Date(time);
  return Number.isFinite(value.getTime()) ? value : null;
}
function renderMessages() {
  const allMessages = currentState().messages,
    messages = messageWindow.select(allMessages, messageHistoryScope(state)),
    messagesById = new Map(allMessages.map((message) => [message.id, message]));
  const timestampFormat = new Intl.DateTimeFormat(languageInfo(language()).locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
  let last: number | null = null;
  return messages
    .map((message) => {
      const date = messageDate(message.time),
        at = date?.getTime() ?? null,
        separator =
          !!date &&
          (last === null ||
            (at !== null && at - last > 1800000) ||
            date.toDateString() !== new Date(last).toDateString());
      if (date && at !== null) last = at;
      const time = separator
        ? `<div class="time-divider" data-key="time-${esc(message.id)}">${formatTime(message.time, true)}</div>`
        : '';
      const timestamp = date ? ` title="${esc(timestampFormat.format(date))}"` : '';
      if (message.kind === 'call') {
        const seconds = Math.max(0, Number(message.seconds) || 0);
        return (
          time +
          `<div class="call-log" data-id="${esc(message.id)}"><span${timestamp}>${ico('phone')}${formatCallDuration(seconds)}<small>· ${t('callEnded')}</small>${chatHistory.renderEdited(message)}</span><div class="message-actions" role="toolbar" aria-label="${t('messageActions')}">${chatHistory.renderActions(message)}</div></div>`
        );
      }
      const messageTime = date
        ? `<time class="message-time" datetime="${date.toISOString()}" aria-label="${esc(timestampFormat.format(date))}">${esc(formatTime(message.time))}</time>`
        : '';
      const replied = message.replyTo ? messagesById.get(message.replyTo) : undefined,
        isUser = message.role === 'user',
        assistantReaction =
          isUser && typeof message.assistantReaction === 'string'
            ? message.assistantReaction
            : null,
        assistantReactionLabel = assistantReaction
          ? t('dantReacted') + reactionName(assistantReaction)
          : '';
      return (
        time +
        `<article class="message ${isUser ? 'user' : 'assistant'} ${emojiFor === message.id ? 'has-picker' : ''}" data-id="${esc(message.id)}"><div class="message-content"><div class="message-bubble-row"><div class="bubble ${!message.text && message.attachments?.length ? 'file-only' : ''}">${taskReplies.renderMessageReference(message)}${replied ? `<blockquote><small>${t('reply')} ${replied.role === 'assistant' ? 'dant' : t('you')}</small>${esc((replied.text || '').slice(0, 240))}</blockquote>` : ''}${message.text ? `<div class="markdown">${md(message.text)}</div>` : ''}${renderAttachments(message.attachments)}${message.status === 'streaming' ? '<span class="stream-cursor"></span>' : ''}</div><div class="message-actions" role="toolbar" aria-label="${t('messageActions')}"><button type="button" title="${t('reply')}" aria-label="${t('reply')}" data-reply="${esc(message.id)}">${ico('reply')}</button><button type="button" title="${t('reactions')}" aria-label="${t('reactions')}" data-picker="${esc(message.id)}">${ico('smile')}</button>${chatHistory.renderActions(message)}${emojiFor === message.id ? `<div class="reaction-menu" role="group" aria-label="${t('reactions')}">${defaultReactions.map((reaction) => `<button type="button" data-react="${esc(message.id)}" data-emoji="${esc(reaction.emoji)}" data-reaction-id="${reaction.id}" title="${esc(translate(language(), reaction.en, reaction.zh))}" aria-label="${esc(translate(language(), reaction.en, reaction.zh))}" aria-pressed="${(message.reactions || []).includes(reaction.emoji)}">${reaction.emoji}</button>`).join('')}</div>` : ''}</div></div><div class="message-meta">${chatHistory.renderEdited(message)}<div class="reactions">${assistantReaction ? `<span class="assistant-reaction" role="img" title="${esc(assistantReactionLabel)}" aria-label="${esc(assistantReactionLabel)}"><small aria-hidden="true">dant</small><span aria-hidden="true">${esc(assistantReaction)}</span></span>` : ''}${(message.reactions || []).map((emoji) => `<button type="button" data-react="${esc(message.id)}" data-emoji="${esc(emoji)}" title="${esc(t('removeReaction') + ': ' + reactionName(emoji))}" aria-label="${esc(t('removeReaction') + ': ' + reactionName(emoji))}" aria-pressed="true">${esc(emoji)}</button>`).join('')}</div>${isUser ? `${message.status === TaskStatus.Completed ? `<span class="task-status ${message.status}">${t(message.status)}</span>` : ''}${messageTime}<span class="delivery-state" title="${t(message.executorConfirmedAt || message.receipt?.readAt ? 'executorRead' : 'received')}">${message.executorConfirmedAt || message.receipt?.readAt || message.status === 'read' ? ico('check-check') : message.receivedAt || hasValue([TaskStatus.Queued, TaskStatus.Accepted, TaskStatus.Running, TaskStatus.Paused, TaskStatus.Review, TaskStatus.Completed], message.status || '') ? ico('check') : ''}</span>` : `${messageTime}${renderAssistantReadState(message)}`}</div>${isUser && hasValue([TaskStatus.Failed, TaskStatus.Interrupted], message.status || '') ? `<button type="button" class="retry-message" data-retry="${esc(message.id)}">${unknownTask(message) ? t('viewUnknown') : t(message.status) + ' · ' + t('retry')}</button>` : ''}${message.error && message.status !== TaskStatus.Cancelled ? `<small class="error">${esc(errorText(message.error))}</small>` : ''}</div></article>`
      );
    })
    .join('');
}
function positionReactionMenus() {
  const viewport = document.querySelector<HTMLElement>('#messages');
  if (!viewport) return;
  const bounds = viewport.getBoundingClientRect();
  if (!bounds.width) return;
  for (const menu of viewport.querySelectorAll<HTMLButtonElement>('.reaction-menu')) {
    menu.style.setProperty('--reaction-shift', '0px');
    menu.style.maxWidth = Math.max(0, bounds.width - 16) + 'px';
    menu.dataset.placement = 'above';
    const rect = menu.getBoundingClientRect(),
      left = bounds.left + 8,
      right = bounds.right - 8,
      shift = rect.left < left ? left - rect.left : rect.right > right ? right - rect.right : 0;
    menu.style.setProperty('--reaction-shift', shift + 'px');
    if (rect.top < bounds.top + 8) menu.dataset.placement = 'below';
  }
}
function renderComputer() {
  const online = computerReachable(),
    agentOnline = computerExecutorReady(),
    connecting =
      pendingActions.has('connect') ||
      currentState().worker.status === ConnectionStatus.Connecting ||
      currentState().controller?.status === ConnectionStatus.Connecting,
    status = connecting
      ? 'connecting'
      : online
        ? !agentOnline
          ? 'vmConnectedAgentOffline'
          : humanControl()
            ? 'takeover'
            : 'controlledByDant'
        : 'computerEmpty',
    connectionAction =
      !agentOnline || connecting
        ? `<button type="button" class="text-btn" data-action="connect" ${connecting ? 'disabled aria-busy="true"' : ''}>${ico('refresh-cw')}${t(connecting ? 'connecting' : 'refresh')}</button>`
        : button('screen-refresh', 'refresh-cw', t('refreshDesktop')),
    pending = pendingActions.has('takeover'),
    blocked = callBlocksControl(),
    controlHint = blocked
      ? 'callControlBusy'
      : online && !humanControl() && !agentOnline
        ? 'agentOfflineControl'
        : null,
    controlHintId = blocked ? 'takeover-call-hint' : 'computer-connection-status';
  return `<div data-key="resize" class="resize-handle" data-workspace-resize="computer" role="separator" aria-label="${t('resizeComputer')}" aria-controls="computer-panel" aria-orientation="vertical" tabindex="0"></div><aside data-key="computer-panel" id="computer-panel" class="computer-panel"><div class="panel-header"><strong>${t('computer')}</strong>${button('hide-computer', 'x', t('close'))}</div><div class="computer-meta"><span id="computer-connection-status" role="status">${t(status)}</span>${connectionAction}</div><div class="screen-frame"><div class="desktop-surface">${online ? `<div class="screen-target ${computerInputReady() ? 'controlling' : ''}" id="screen-target" tabindex="${computerInputReady() ? 0 : -1}" aria-label="${t('vmDesktop')}"><img id="screen" ${screenURL ? `src="${screenURL}"` : ''} alt="${t('ubuntuDesktop')}" draggable="false"><textarea id="vm-ime" ${computerInputReady() ? '' : 'disabled'} aria-label="${t('vmKeyboard')}" autocapitalize="off" autocomplete="off"></textarea>${!screenURL || screenError ? `<div class="screen-status" data-key="screen-status">${esc(screenError ? t('screenFailed') : t('loadingDesktop'))}</div>` : ''}</div>` : `<div class="computer-empty">${ico('monitor')}<h3>${t('computerEmpty')}</h3><p>${t('computerSub')}</p><button type="button" class="text-btn" data-action="computer-settings">${t('setup')}</button></div>`}</div></div><div class="computer-footer ${controlHint ? 'control-unavailable' : ''}">${online ? `<button type="button" class="text-btn primary takeover-button" data-action="takeover" ${pending || controlHint ? 'disabled' : ''} ${controlHint ? `title="${t(controlHint)}" aria-describedby="${controlHintId}"` : ''}>${t(pending ? (humanControl() ? 'returningControl' : 'takingControl') : humanControl() ? 'give' : 'take')}</button>` : `<span>Ubuntu · ${t('computerHint')}</span>`}${blocked && controlHint ? `<p id="${controlHintId}" class="takeover-call-hint" role="status">${t(controlHint)}</p>` : ''}</div></aside>`;
}
function renderSettings() {
  const settings = currentState().settings,
    existing = !!settings.vm.host || !!currentState().provisioning?.connection;
  const sections = {
    general: () =>
      `<section class="settings-section setting-card language-card"><div class="card-label"><h2>${t('language')}</h2><p>${t('languageHint')}</p></div><div class="card-content"><select id="language" data-language class="language-select" aria-label="${t('language')}" dir="ltr" ${pendingActions.has('setting:language') ? 'disabled aria-busy="true"' : ''}>${languages.map((item) => `<option value="${item.code}" lang="${item.locale}" dir="${item.direction}" ${settings.language === item.code ? 'selected' : ''}>${item.label}</option>`).join('')}</select></div></section><section class="settings-section setting-card"><div class="card-label"><h2>${t('notify')}</h2></div><div class="card-content"><div class="setting-row"><div>${t('notifySub')}</div><input type="checkbox" id="notifications" ${settings.notifications ? 'checked' : ''} aria-label="${t('notify')}"></div></div></section><section class="settings-section setting-card"><div class="card-label"><h2>${t('progress')}</h2></div><div class="card-content"><div class="setting-row"><label for="showWorkSummary">${t('showWorkSummary')}</label><input type="checkbox" id="showWorkSummary" ${settings.showWorkSummary === true ? 'checked' : ''} ${pendingActions.has('setting:showWorkSummary') ? 'disabled' : ''} aria-label="${t('showWorkSummary')}"></div><p class="card-description">${t('showWorkSummaryHint')}</p></div></section>${textEditor.renderSettings()}`,
    appearance: () => renderAppearance(),
    voice: () => renderVoiceSettings(settings),
    computer: () =>
      `${renderVMSettings()}${vmBackups.renderImport()}<section class="settings-section setting-card" data-setting-card="permissions"><div class="card-label"><h2>${t('adminPermissions')}</h2></div><div class="card-content">${existing ? `<p class="card-description">${t('currentPermissions')}</p>${button('computer', 'monitor', t('viewComputer'), 'text-btn')}` : `<div class="segmented permission-options" role="group" aria-label="${t('adminPermissions')}"><button type="button" data-permission="standard" class="${!provisionDraft.adminSudo ? 'selected' : ''}" aria-pressed="${!provisionDraft.adminSudo}">${t('standardPermissions')}</button><button type="button" data-permission="admin" class="${provisionDraft.adminSudo ? 'selected' : ''}" aria-pressed="${provisionDraft.adminSudo}">${t('fullPermissions')}</button></div><p class="card-description">${t(provisionDraft.adminSudo ? 'permissionsAdminHint' : 'permissionsStandardHint')}</p><small class="muted">${t('permissionsForNew')}</small>`}</div></section>`,
    account: () =>
      `<section class="settings-section setting-card" data-setting-card="account"><div class="card-label"><h2>${t('accountSubscription')}</h2></div><div class="card-content"><div class="setting-row"><div><strong>${esc(currentState().worker.account?.email || 'ChatGPT')}</strong><small>${esc(currentState().worker.account?.planType || t('offline'))}</small></div><button type="button" class="text-btn ${currentState().worker.account ? '' : 'primary'}" data-action="${currentState().worker.account ? 'logout' : 'login'}">${t(currentState().worker.account ? 'logout' : 'login')}</button></div><p class="card-description">${t('subscriptionTasks')}</p><div id="login-details">${renderLoginDetails()}</div><div class="setting-row model-setting"><span>${t('model')}</span><select id="model" aria-label="${t('model')}"><option value="">${t('default')}</option>${currentState()
        .worker.models.map(
          (model) =>
            `<option value="${esc(model.model)}" ${model.model === settings.model ? 'selected' : ''}>${esc(model.displayName || model.model)}</option>`,
        )
        .join('')}</select></div></div></section>`,
    usage: () =>
      renderUsageSettings({
        ...(currentState().usage === undefined ? {} : { usage: currentState().usage }),
        language: language(),
        cached: currentState().controller?.cached === true,
        ...usageActivity.state,
      }),
    credentials: () => managedSettings.renderCredentials(),
    history: () =>
      `${chatHistory.renderSettings()}${vmBackups.render()}<div class="settings-links">${button('memory', 'brain', t('memory'), 'text-btn')}</div>`,
    telegram: () => renderTelegramSettings(),
    about: () => appUpdates.render(),
  };
  return settingsNavigation.render(sections);
}
async function loadSettingsCategory(category: string) {
  if (category === 'general') await textEditor.load();
  if (category === 'appearance') await loadFonts();
  if (category === 'telegram') await loadTelegram();
  if (category === 'credentials') await managedSettings.load();
  if (category === 'voice') await loadVoices();
}
const accentChoices = ['#3468FF', '#8660D9', '#CE5A8E', '#C27832', '#409572', '#6D737D'];
function appearanceColor(name: 'accentColor' | 'backgroundColor' | 'foregroundColor') {
  const selected = appearance.preferences,
    value = selected[name];
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value;
  const token = {
      accentColor: '--accent-color',
      backgroundColor: '--surface',
      foregroundColor: '--text',
    }[name],
    painted = globalThis
      .getComputedStyle?.(document.documentElement)
      ?.getPropertyValue(token)
      ?.trim();
  return typeof painted === 'string' && /^#[0-9a-f]{6}$/i.test(painted)
    ? painted
    : name === 'accentColor'
      ? '#3468FF'
      : name === 'backgroundColor'
        ? document.documentElement.dataset.theme === 'dark'
          ? '#181818'
          : '#FFFFFF'
        : document.documentElement.dataset.theme === 'dark'
          ? '#E8E8E8'
          : '#262626';
}
function renderAppearance() {
  const selected = appearance.preferences,
    preset = selected.themePreset || 'chatgpt',
    fonts = fontInventory?.fonts || [],
    matches = fonts.filter((family) =>
      family.toLocaleLowerCase().includes(fontSearch.toLocaleLowerCase()),
    ),
    fontLabel =
      selected.fontFamily ||
      t(
        { system: 'fontSystem', sans: 'fontSans', mono: 'fontMono' }[selected.font] || 'fontSystem',
      );
  const modes = (
    [
      ['system', 'themeSystem'],
      ['light', 'themeLight'],
      ['dark', 'themeDark'],
    ] as const
  )
    .map(
      ([value, label]) =>
        `<button type="button" class="appearance-mode ${value}" data-theme="${value}" aria-label="${t(label)}" aria-pressed="${selected.theme === value}" title="${t(label)}"><span class="mode-preview" aria-hidden="true"><i></i><b><em></em><em></em><em></em></b></span><small>${t(label)}</small></button>`,
    )
    .join('');
  const colors = (['backgroundColor', 'foregroundColor'] as const)
    .map(
      (key, index) =>
        `<div class="appearance-row"><span>${t(index ? 'foreground' : 'background')}</span><div class="appearance-color-control"><label class="color-chip"><input type="color" id="appearance-${key}" value="${appearanceColor(key)}" aria-label="${t(index ? 'foreground' : 'background')}"><span>${appearanceColor(key).toUpperCase()}</span></label><button type="button" class="icon-btn color-reset" data-reset-color="${key}" title="${t('resetColor')}" aria-label="${t('resetColor')}" ${selected[key] === null || selected[key] === undefined ? 'disabled' : ''}>${ico('refresh-cw')}</button></div></div>`,
    )
    .join('');
  const fontOptions = matches
    .slice(0, 120)
    .map(
      (family) =>
        `<button type="button" class="font-choice" data-font-family="${esc(family)}" aria-pressed="${selected.fontFamily === family}">${esc(family)}${selected.fontFamily === family ? ico('check') : ''}</button>`,
    )
    .join('');
  const sizes = (
    [
      ['appearance-size', 'uiFontSize', 'uiFontSizeHint', 'fontSize'],
      ['appearance-content-size', 'contentFontSize', 'contentFontSizeHint', 'contentFontSize'],
      ['appearance-code-size', 'codeFontSize', 'codeFontSizeHint', 'codeFontSize'],
    ] as const
  )
    .map(
      ([id, label, hint, key]) =>
        `<label class="appearance-row"><span>${t(label)}<small>${t(hint)}</small></span><input id="${id}" type="number" min="${appearanceFontRanges[key][0]}" max="${appearanceFontRanges[key][1]}" step="1" value="${selected[key] ?? appearanceDefaults[key]}" aria-label="${t(label)}"></label>`,
    )
    .join('');
  return `<section class="settings-section appearance-settings"><h2>${t('appearance')}</h2><h3>${t('visualStyle')}</h3><div class="appearance-group appearance-mode-row"><span>${t('appearanceMode')}</span><div class="appearance-modes" role="group" aria-label="${t('appearanceMode')}">${modes}</div></div><div class="appearance-group"><div class="appearance-row"><span>${t('themePreset')}</span><div class="appearance-theme-controls"><button type="button" class="icon-btn" id="appearance-export" aria-label="${t('exportTheme')}" title="${t('exportTheme')}">${ico('download')}</button><button type="button" class="icon-btn" id="appearance-import" aria-label="${t('importTheme')}" title="${t('importTheme')}">${ico('arrow-up')}</button><select id="appearance-preset" aria-label="${t('themePreset')}">${(
    [
      ['dant', 'themeDant'],
      ['chatgpt', 'themeChatgpt'],
      ['warm', 'themeWarm'],
      ['custom', 'themeCustom'],
    ] as const
  )
    .map(
      ([value, label]) =>
        `<option value="${value}" ${preset === value ? 'selected' : ''}>${t(label)}</option>`,
    )
    .join(
      '',
    )}</select><input type="file" id="appearance-import-file" accept="application/json,.json" hidden></div></div><div class="appearance-row"><span>${t('accent')}</span><div class="accent-choices" role="group" aria-label="${t('accent')}">${accentChoices.map((color) => `<button type="button" data-accent="${color}" style="--swatch:${color}" aria-label="${t('accent')} ${color}" aria-pressed="${appearanceColor('accentColor').toUpperCase() === color}"></button>`).join('')}<input type="color" id="appearance-accentColor" value="${appearanceColor('accentColor')}" aria-label="${t('colorValue')}"></div></div>${colors}<div class="appearance-row appearance-font-row"><span>${t('font')}</span><details class="font-picker" id="appearance-font-picker" ${fontMenuOpen ? 'open' : ''}><summary>${esc(fontLabel)}${ico('chevron-down')}</summary><div class="font-popover"><input id="appearance-font-search" type="search" value="${esc(fontSearch)}" placeholder="${t('searchFonts')}" aria-label="${t('searchFonts')}" autocomplete="off"><div class="font-defaults">${(
    [
      ['system', 'fontSystem'],
      ['sans', 'fontSans'],
      ['mono', 'fontMono'],
    ] as const
  )
    .map(
      ([value, label]) =>
        `<button type="button" data-font="${value}" aria-pressed="${!selected.fontFamily && selected.font === value}">${t(label)}</button>`,
    )
    .join(
      '',
    )}</div>${fontLoading ? `<p class="muted">${t('fontsLoading')}</p>` : fontError ? `<p class="error">${t('fontsUnavailable')}</p>` : fontInventory?.source === 'fallback' ? `<p class="muted">${t('fontsFallback')}</p>` : ''}<div class="font-options">${fontOptions || (!fontLoading && fontSearch ? `<p class="muted">${t('noMatchingFonts')}</p>` : '')}</div></div></details></div></div><details class="appearance-advanced" id="appearance-advanced" ${appearanceAdvanced ? 'open' : ''}><summary>${t('advanced')}${ico('chevron-down')}</summary><div class="appearance-group">${sizes}</div><div class="appearance-group"><label class="appearance-row"><span>${t('reduceMotion')}<small>${t('reduceMotionHint')}</small></span><select id="appearance-motion" aria-label="${t('reduceMotion')}">${(
    [
      ['system', 'motionSystem'],
      ['reduce', 'motionReduce'],
      ['full', 'motionFull'],
    ] as const
  )
    .map(
      ([value, label]) =>
        `<option value="${value}" ${(selected.reduceMotion || 'system') === value ? 'selected' : ''}>${t(label)}</option>`,
    )
    .join('')}</select></label></div></details></section>`;
}
async function changeAppearance(patch: unknown) {
  const saving = appearance.update(patch);
  render();
  try {
    const preferences = await saving;
    Object.assign(currentState().settings, preferences);
  } finally {
    Object.assign(currentState().settings, appearance.preferences);
    render();
  }
}
async function loadFonts() {
  if (fontInventory || fontLoading) return;
  fontLoading = true;
  fontError = '';
  render();
  try {
    const result = await api('/fonts');
    if (!Array.isArray(result.fonts)) throw Error('Font list is invalid');
    fontInventory = {
      fonts: [
        ...new Set(
          result.fonts.filter((value) => typeof value === 'string' && value.length <= 128),
        ),
      ],
      ...(result.source === undefined ? {} : { source: result.source }),
    };
  } catch (cause) {
    const error = requestError(cause);
    fontError = error.message;
  } finally {
    fontLoading = false;
    render();
  }
}
function appearanceExportData(): unknown {
  return JSON.parse(serializeAppearance(appearance.preferences));
}
async function importAppearanceData(text: string) {
  let patch;
  try {
    patch = parseAppearance(text);
  } catch {
    throw Error(t('themeImportInvalid'));
  }
  await changeAppearance(patch);
  toast(t('themeImported'));
}
function exportAppearance() {
  const blob = new Blob([JSON.stringify(appearanceExportData(), null, 2)], {
      type: 'application/json',
    }),
    url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = 'dant-appearance.json';
  link.click();
  URL.revokeObjectURL(url);
}

function bindAppearance() {
  const update = (patch: unknown) =>
    changeAppearance(patch).catch((error) => toast(errorText(error)));
  document
    .querySelectorAll<HTMLButtonElement>('.appearance-settings button[data-theme]')
    .forEach((button) => (button.onclick = () => update({ theme: button.dataset.theme })));
  document
    .querySelectorAll<HTMLButtonElement>('.appearance-settings button[data-accent]')
    .forEach(
      (button) =>
        (button.onclick = () =>
          update({ themePreset: 'custom', accentColor: button.dataset.accent })),
    );
  document
    .querySelectorAll<HTMLButtonElement>('.appearance-settings button[data-reset-color]')
    .forEach(
      (button) => (button.onclick = () => update({ [requiredData(button, 'resetColor')]: null })),
    );
  document.querySelectorAll<HTMLButtonElement>('.appearance-settings button[data-font]').forEach(
    (button) =>
      (button.onclick = () => {
        fontMenuOpen = false;
        fontSearch = '';
        return update({ font: button.dataset.font, fontFamily: '' });
      }),
  );
  document
    .querySelectorAll<HTMLButtonElement>('.appearance-settings button[data-font-family]')
    .forEach(
      (button) =>
        (button.onclick = () => {
          if (
            !button.dataset.fontFamily ||
            !fontInventory?.fonts.includes(button.dataset.fontFamily)
          )
            return;
          fontMenuOpen = false;
          fontSearch = '';
          return update({ fontFamily: button.dataset.fontFamily });
        }),
    );
  for (const [id, key] of [
    ['appearance-size', 'fontSize'],
    ['appearance-content-size', 'contentFontSize'],
    ['appearance-code-size', 'codeFontSize'],
    ['appearance-motion', 'reduceMotion'],
    ['appearance-accentColor', 'accentColor'],
    ['appearance-backgroundColor', 'backgroundColor'],
    ['appearance-foregroundColor', 'foregroundColor'],
  ] as const) {
    const input = document.querySelector<HTMLInputElement | HTMLSelectElement>('#' + id);
    if (input)
      input.onchange = () =>
        update({
          [key]: key.endsWith('FontSize') || key === 'fontSize' ? Number(input.value) : input.value,
          ...(key.endsWith('Color') ? { themePreset: 'custom' } : {}),
        });
  }
  const preset = document.querySelector<HTMLSelectElement>('#appearance-preset');
  if (preset)
    preset.onchange = () =>
      update({
        themePreset: preset.value,
        accentColor: null,
        backgroundColor: null,
        foregroundColor: null,
      });
  const advanced = document.querySelector<HTMLDetailsElement>('#appearance-advanced');
  if (advanced) advanced.ontoggle = () => (appearanceAdvanced = advanced.open);
  const picker = document.querySelector<HTMLDetailsElement>('#appearance-font-picker');
  if (picker)
    picker.ontoggle = () => {
      fontMenuOpen = picker.open;
      if (picker.open) loadFonts();
    };
  const search = document.querySelector<HTMLInputElement>('#appearance-font-search');
  if (search)
    search.oninput = () => {
      fontSearch = search.value;
      render();
    };
  const exporting = document.querySelector<HTMLElement>('#appearance-export');
  if (exporting) exporting.onclick = exportAppearance;
  const importing = document.querySelector<HTMLElement>('#appearance-import'),
    file = document.querySelector<HTMLInputElement>('#appearance-import-file');
  if (importing && file) {
    importing.onclick = () => file.click();
    file.onchange = async () => {
      const selected = file.files?.[0];
      file.value = '';
      if (!selected) return;
      try {
        if (selected.size > MAX_APPEARANCE_IMPORT_BYTES) throw Error(t('themeImportLimit'));
        await importAppearanceData(await selected.text());
      } catch (cause) {
        const error = requestError(cause);
        toast(errorText(error));
      }
    };
  }
}
function bindVMSettings() {
  document.querySelectorAll<HTMLInputElement>('[name="vm-profile"]').forEach(
    (input) =>
      (input.onchange = () => {
        selectedVMProfile = input.value;
        render();
      }),
  );
  const importForm = document.querySelector<HTMLFormElement>('#vm-import-form');
  if (importForm) {
    importForm.oninput = () => (legacyVMDirectory = formInput(importForm, 'directory').value);
    importForm.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await importVMProfile({ directory: formInput(importForm, 'directory').value.trim() });
      } catch (cause) {
        const error = requestError(cause);
        toast(errorText(error));
      }
    };
  }
  const vmForm = document.querySelector<HTMLFormElement>('#vm-form');
  if (vmForm) {
    vmForm.oninput = () => (vmDraft = formVM(vmForm));
    vmForm.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await saveAndConnectVM();
      } catch (cause) {
        const error = requestError(cause);
        toast(errorText(error));
      }
    };
  }
}
function hasVMConnection() {
  const vm = state?.settings?.vm;
  return !!(
    vm?.host?.trim() &&
    vm?.user?.trim() &&
    vm?.keyPath?.trim() &&
    Number.isInteger(Number(vm.port)) &&
    Number(vm.port) > 0 &&
    Number(vm.port) <= 65535
  );
}
function renderVMSettings() {
  const settings = currentState().settings,
    vm = vmDraft || settings.vm,
    online = currentState().worker.status === ConnectionStatus.Online,
    configured = hasVMConnection(),
    paused = currentState().controller?.updatesPaused === true,
    service = currentState().controller?.serviceUpdate,
    known =
      configured &&
      service &&
      hasValue(
        [
          ServiceUpdateStatus.Checking,
          ServiceUpdateStatus.Updating,
          ServiceUpdateStatus.Pending,
          ServiceUpdateStatus.Current,
          ServiceUpdateStatus.Failed,
        ],
        service.status,
      ),
    confirmed =
      service?.confirmed === true &&
      currentState().controller?.status === ConnectionStatus.Online &&
      currentState().controller?.cached !== true,
    status =
      service?.status === ServiceUpdateStatus.Current && !confirmed ? 'pending' : service?.status,
    busy =
      pendingActions.has('connect') ||
      pendingActions.has('service-update') ||
      pendingActions.has('import-vm') ||
      currentState().controller?.serviceUpdateBusy === true ||
      (known &&
        hasValue([ServiceUpdateStatus.Checking, ServiceUpdateStatus.Updating], status || ''));
  const version = (value: unknown) =>
    typeof value === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) &&
    value.length <= 80
      ? value
      : '';
  const versions = known
    ? [
        ['serviceTarget', version(service.targetVersion)],
        ['serviceRunning', version(service.runningVersion)],
      ]
        .filter(([, value]) => value)
        .map(([label, value]) => t(label) + ' ' + value)
        .join(' · ')
    : '';
  const serviceNotice = known
    ? `<div class="vm-service-update ${status === ServiceUpdateStatus.Failed ? 'error' : 'muted'}" data-service-update="${status}" role="status" aria-live="polite"><strong>${t(paused ? 'servicePaused' : serviceStatusLabel(status))}</strong>${versions ? `<small>${esc(versions)}</small>` : ''}<p>${t(paused ? 'servicePauseHint' : status === ServiceUpdateStatus.Failed ? 'serviceUpdateError' : status === ServiceUpdateStatus.Pending ? (service.reason === 'work-active' ? 'serviceWaitWork' : 'serviceWaitConfirm') : 'serviceAutoHint')}</p><div class="inline-actions service-update-actions">${button(paused ? 'service-resume' : 'service-pause', paused ? 'play' : 'pause', t(paused ? 'serviceResume' : 'servicePause'), 'text-btn', busy)}${hasValue([ServiceUpdateStatus.Pending, ServiceUpdateStatus.Failed], status || '') ? button('service-install', 'download', t('serviceInstall'), 'text-btn', busy) : ''}</div></div>`
    : '';
  return `<section class="settings-section setting-card vm-settings"><div class="card-label"><h2>Ubuntu ${t('computer')}</h2></div><div class="card-content"><div class="setting-row computer-summary"><div><strong>${esc(vmSystemDescription())}</strong><small>${t(online ? 'online' : currentState().worker.status)}${settings.vm.host ? ' · ' + esc(settings.vm.host) : ''}</small></div><span class="status-label ${online ? 'connected' : ''}">${t(online ? 'online' : 'offline')}</span></div>${serviceNotice}${currentState().worker.error ? `<p class="error" role="status">${esc(errorText(currentState().worker.error))}</p>` : ''}<div class="inline-actions">${button('use-existing', 'monitor', t('useExistingComputer'), 'text-btn ' + (!configured ? 'primary' : ''), busy)}${configured ? button('connect', 'refresh-cw', t('refresh'), 'text-btn', busy) : ''}${button('setup', 'plus', t('createComputer'), 'text-btn', busy)}</div>${Boolean(pc || callStarting || currentState().call || callStops.pending) ? `<p class="takeover-call-hint" role="status">${t('endCallBeforeConnection')}</p>` : ''}${vmProfilesVisible ? renderVMProfiles() : ''}<details class="manual-vm-details" id="manual-vm-options" ${manualVMExpanded ? 'open' : ''}><summary>${t('manualConnection')}</summary><p class="muted">${t('manualVMHint')}</p><form id="vm-form"><div class="form-grid"><label>${t('host')}<input name="host" value="${esc(vm.host)}" placeholder="172.20.0.10" required></label><label>${t('user')}<input name="user" value="${esc(vm.user || 'dant')}" required></label><label>${t('port')}<input name="port" type="number" min="1" max="${MAX_PORT}" value="${esc(vm.port || DEFAULT_SSH_PORT)}" required></label><label class="wide">${t('key')}<input name="keyPath" value="${esc(vm.keyPath)}" placeholder="C:/path/to/dant/data/vm-key" required></label></div><div class="form-actions"><button class="text-btn primary" type="submit" ${busy ? 'disabled' : ''}>${t('saveAndConnect')}</button></div></form></details></div></section>`;
}
function renderVMProfiles() {
  const candidates = vmProfiles?.candidates || [],
    current = vmProfiles?.current,
    protectedCurrent = !!current,
    busy = pendingActions.has('import-vm') || pendingActions.has('connect');
  return `<div class="vm-profiles"><h3>${t('existingProfiles')}</h3>${vmProfilesBusy ? `<p class="muted" role="status">${t('findVMProfiles')}</p>` : ''}${vmProfilesError ? `<p class="error">${esc(errorText(vmProfilesError))}</p>` : ''}${protectedCurrent ? `<p class="muted">${t('currentVMProtected')}</p><div class="vm-current"><strong>${t('currentVMProfile')}</strong><span>${esc(current.label || current.host || '')} ${current.host ? `· ${esc(current.user || 'dant')}@${esc(current.host)}:${esc(current.port || DEFAULT_SSH_PORT)}` : ''}</span></div>` : ''}${candidates.length ? `<fieldset class="vm-profile-options"><legend>${t('selectVMProfile')}</legend>${candidates.map((profile) => `<label><input type="radio" name="vm-profile" value="${esc(profile.id)}" ${selectedVMProfile === profile.id ? 'checked' : ''} ${busy || protectedCurrent ? 'disabled' : ''}><span><strong>${esc(profile.label || profile.host)}</strong><small>${esc(profile.user || 'dant')}@${esc(profile.host)}:${esc(profile.port || DEFAULT_SSH_PORT)}</small>${profile.directory ? `<small>${esc(profile.directory)}</small>` : ''}</span></label>`).join('')}</fieldset><button type="button" class="text-btn" data-action="import-vm-profile" ${!selectedVMProfile || busy || protectedCurrent ? 'disabled' : ''}>${t('importAndConnect')}</button>` : !vmProfilesBusy && !protectedCurrent ? `<p class="muted">${t('noVMProfiles')}</p>` : ''}${!protectedCurrent ? `<form id="vm-import-form"><label>${t('legacyVMDirectory')}<input name="directory" value="${esc(legacyVMDirectory)}" placeholder="C:/path/to/dant/data" required ${busy ? 'disabled' : ''}></label><small class="muted">${t('legacyVMHint')}</small><div class="form-actions"><button type="submit" class="text-btn" ${busy ? 'disabled' : ''}>${t('importDirectory')}</button></div></form>` : ''}</div>`;
}
async function useExistingComputer() {
  page = 'settings';
  modal = null;
  manualVMExpanded = true;
  vmProfilesVisible = true;
  settingsNavigation.select('computer');
  if (vmProfilesBusy) {
    render();
    return;
  }
  vmProfilesBusy = true;
  vmProfilesError = '';
  render();
  try {
    const result = await api('/vm/profiles');
    vmProfiles = {
      ...result,
      candidates: Array.isArray(result.candidates) ? result.candidates : [],
    };
    if (!vmProfiles.candidates.some((profile) => profile.id === selectedVMProfile))
      selectedVMProfile =
        vmProfiles.candidates.length === 1 ? vmProfiles.candidates[0]?.id || '' : '';
    if (result.error) vmProfilesError = result.error;
  } catch (cause) {
    const error = requestError(cause);
    vmProfilesError = error.message || String(error);
  } finally {
    vmProfilesBusy = false;
    render();
    if (page === 'settings' && manualVMExpanded && !vmProfiles?.candidates.length)
      document
        .querySelector<HTMLInputElement>('#vm-form input[name="host"]')
        ?.focus({ preventScroll: true });
  }
}
async function connectVM() {
  if (!hasVMConnection()) {
    await useExistingComputer();
    toast(t('vmConfigNeeded'));
    return false;
  }
  voiceLoadedFor = '';
  toast(t('connecting'));
  await post('/connect');
  state = await api('/state');
  toast(
    t(
      currentState().worker.status === ConnectionStatus.Online
        ? 'online'
        : currentState().worker.status,
    ),
  );
  return true;
}
async function saveAndConnectVM() {
  if (pendingActions.has('connect')) return;
  pendingActions.add('connect');
  render();
  try {
    if ((await saveVM()) && (await connectVM())) {
      manualVMExpanded = false;
      vmProfilesVisible = false;
    }
  } finally {
    pendingActions.delete('connect');
    render();
  }
}
async function importVMProfile(body: unknown) {
  if (pendingActions.has('import-vm')) return;
  pendingActions.add('import-vm');
  render();
  try {
    await post('/vm/import', body);
    state = await api('/state');
    vmDraft = null;
    if (await connectVM()) {
      vmProfilesVisible = false;
      manualVMExpanded = false;
    }
  } finally {
    pendingActions.delete('import-vm');
    render();
  }
}
function currentTelegram() {
  return (
    state?.telegram ||
    state?.worker?.telegram ||
    telegramStatus || {
      enabled: false,
      configured: false,
      connected: false,
      bot: null,
      paired: false,
      owner: null,
      pairing: null,
      lastError: null,
      delivery: { failed: 0, unknown: 0 },
    }
  );
}
function telegramOnline() {
  return eventConnected && state?.worker?.status === ConnectionStatus.Online;
}
function telegramForwardingCopy() {
  return language() === 'zh'
    ? {
        title: '消息转发',
        mode: '转发到 Telegram',
        unread: '仅未读回复（推荐）',
        all: '所有回复',
        hint: '“所有回复”也会转发已在 dant 中读过的回复。',
        combine: '合并连续回复',
        combineHint: '将连续的文字回复合并发送，附件单独送达。',
        independent: 'dant 与 Telegram 的已读／未读状态保持独立。',
        update: '工作电脑会自动更新服务；完成后可配置消息转发。请在设置 → 工作电脑查看状态。',
        saved: 'Telegram 转发设置已保存',
        failed: '转发设置未能保存，原设置已保留。',
      }
    : {
        title: 'Message forwarding',
        mode: 'Forward to Telegram',
        unread: 'Unread replies only (recommended)',
        all: 'All replies',
        hint: 'All replies also forwards replies already read in dant.',
        combine: 'Combine consecutive replies',
        combineHint:
          'Send consecutive text replies together; attachments are delivered separately.',
        independent: 'Read/unread status stays independent in dant and Telegram.',
        update:
          'The work computer service updates automatically. Check its status in Settings → Work computer before configuring forwarding.',
        saved: 'Telegram forwarding settings saved',
        failed: 'Forwarding settings could not be saved. Your previous settings were kept.',
      };
}
function telegramForwarding(status = currentTelegram()) {
  const sync = status?.sync,
    supported =
      sync &&
      (sync.forwardMode === 'unread' || sync.forwardMode === 'all') &&
      typeof sync.combineReplies === 'boolean' &&
      sync.readState === 'independent';
  return {
    supported: Boolean(supported),
    forwardMode: supported ? sync.forwardMode : 'unread',
    combineReplies: supported ? sync.combineReplies : true,
  };
}
function telegramForwardingOnline() {
  return (
    telegramOnline() &&
    state?.controller?.cached !== true &&
    (state?.controller?.status === undefined ||
      currentState().controller?.status === ConnectionStatus.Online)
  );
}
function telegramSettingsScope() {
  const vm = state?.settings?.vm;
  return JSON.stringify([state?.conversationId, vm?.host, vm?.user, vm?.port, vm?.keyPath]);
}
function renderTelegramForwardingChange(draft: string | null, owner: string | null) {
  render();
  if (owner === telegramSettingsScope() && typeof draft === 'string') {
    const input = document.querySelector<HTMLInputElement>('#telegram-token');
    if (input) input.value = draft;
  }
}
function renderTelegramForwarding(
  status = currentTelegram(),
  {
    online = telegramForwardingOnline(),
    busy = telegramLoading || pendingActions.has('telegram'),
  } = {},
) {
  const words = telegramForwardingCopy(),
    preferences = telegramForwarding(status),
    locked = !online || busy || !preferences.supported;
  return `<section class="settings-section setting-card telegram-forwarding-settings"><div class="card-label"><h2>${words.title}</h2></div><div class="card-content"><label class="telegram-forwarding-mode" for="telegram-forward-mode"><span>${words.mode}</span><select id="telegram-forward-mode" aria-describedby="telegram-forwarding-hint" ${locked ? 'disabled' : ''}><option value="unread" ${preferences.forwardMode === 'unread' ? 'selected' : ''}>${words.unread}</option><option value="all" ${preferences.forwardMode === 'all' ? 'selected' : ''}>${words.all}</option></select></label><p class="telegram-forwarding-hint" id="telegram-forwarding-hint">${words.hint}</p><label class="telegram-forwarding-combine"><input type="checkbox" id="telegram-combine-replies" ${preferences.combineReplies ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${words.combine}<small>${words.combineHint}</small></span></label><p class="telegram-forwarding-hint">${words.independent}</p>${!preferences.supported ? `<p class="telegram-forwarding-update" role="status">${words.update}</p>` : ''}</div></section>`;
}
function renderTelegramSettings() {
  return renderTelegramConnectionSettings() + renderTelegramForwarding();
}
function renderTelegramConnectionSettings() {
  const status = currentTelegram(),
    online = telegramOnline(),
    busy = telegramLoading || pendingActions.has('telegram'),
    activeCode =
      telegramPairing && telegramPairing.expiresAt > Date.now() && !status.paired
        ? telegramPairing
        : null,
    pairExpiresAt = status.pairing?.expiresAt ?? 0,
    pendingPair = pairExpiresAt > Date.now(),
    botUrl = activeCode && telegramBotURL(activeCode.botUrl),
    connectionError = telegramConnectionError(status),
    delivery = telegramDeliveryNotice(status, {
      language: language(),
      online,
      formatTime: (value) => formatTime(value, true),
    });
  return `<section class="settings-section setting-card telegram-settings"><div class="card-label"><h2>${t('telegram')}</h2></div><div class="card-content"><p class="card-description">${t('telegramHint')}</p>${!online ? `<p class="muted" role="status">${t('telegramOffline')}</p>` : ''}<div class="setting-row"><div><strong>${esc(status.bot?.username ? '@' + status.bot.username : t('telegram'))}</strong><small>${t(status.enabled ? (status.connected ? 'telegramConnected' : 'telegramConnecting') : 'telegramDisabled')}</small></div><button type="button" class="text-btn" data-action="telegram-toggle" ${!online || !status.configured || busy ? 'disabled' : ''}>${t(status.enabled ? 'telegramDisable' : 'telegramEnable')}</button></div><p class="telegram-token-state">${t(status.configured ? 'telegramTokenConfigured' : 'telegramTokenMissing')}</p>${telegramLoading ? `<p class="muted" role="status">${t('telegramLoading')}</p>` : ''}${telegramError ? `<p class="error" role="status">${esc(errorText(telegramError))}</p>` : ''}${connectionError ? `<p class="error telegram-connection-error" role="status">${esc(errorText(connectionError))}</p>` : ''}<form id="telegram-token-form" autocomplete="off"><label>${t('telegramToken')}<input id="telegram-token" name="token" type="password" placeholder="123456:…" autocomplete="off" autocapitalize="off" spellcheck="false" required ${!online || busy ? 'disabled' : ''}></label>${status.configured ? `<small class="muted">${t('telegramTokenChange')}</small>` : ''}<div class="form-actions"><button type="submit" class="text-btn" ${!online || busy ? 'disabled' : ''}>${t(status.configured ? 'telegramTokenUpdate' : 'telegramTokenSave')}</button>${status.configured ? `<button type="button" class="text-btn" data-action="telegram-remove" ${!online || busy ? 'disabled' : ''}>${t('telegramRemoveToken')}</button>` : ''}</div></form><div class="telegram-pair-status"><strong>${t(status.paired ? 'telegramPaired' : 'telegramUnpaired')}</strong>${status.paired && status.owner ? `<small>${t('telegramAccount')} · ${esc(status.owner.userId || status.owner.chatId)}</small>` : ''}${pendingPair && !activeCode ? `<small>${t('telegramPairPending')} · ${formatTime(pairExpiresAt, true)}</small>` : ''}</div>${activeCode ? `<div class="telegram-pair-code"><p>${t('telegramPairHint')}</p><code>${esc(activeCode.code)}</code><small>${t('telegramCodeExpiry')} · ${formatTime(activeCode.expiresAt, true)}</small>${botUrl ? `<a class="text-btn" href="${esc(botUrl)}" target="_blank" rel="noopener noreferrer">${ico('external-link')}${t('telegramOpenBot')}</a>` : ''}</div>` : ''}<div class="inline-actions"><button type="button" class="text-btn" data-action="telegram-pair" ${!online || !status.configured || !status.enabled || status.paired || busy ? 'disabled' : ''}>${t(activeCode || pendingPair ? 'telegramPairAgain' : 'telegramPair')}</button>${status.paired || activeCode || pendingPair ? `<button type="button" class="text-btn" data-action="telegram-unpair" ${!online || busy ? 'disabled' : ''}>${t('telegramUnpair')}</button>` : ''}</div>${!status.enabled ? `<small class="muted">${t('telegramEnableForPair')}</small>` : ''}${delivery ? `<div class="telegram-delivery-notice" role="status"><strong>${esc(delivery.summary)}</strong>${delivery.latest ? `<small>${esc(delivery.latest)}</small>` : ''}${delivery.reassurance ? `<p>${esc(delivery.reassurance)}</p>` : ''}<p>${esc(delivery.hint)}</p></div>` : ''}</div></section>`;
}
function telegramBotURL(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 't.me' ? url.href : '';
  } catch {
    return '';
  }
}
function setTelegramStatus(value: Partial<TelegramStatus>, { preservePairing = false } = {}) {
  telegramStatus = value;
  if (state) {
    currentState().telegram = value;
    if (currentState().worker) currentState().worker.telegram = value;
  }
  if (value.paired && !preservePairing) clearTelegramPairing();
}
function clearTelegramPairing() {
  if (telegramPairTimer !== null) clearTimeout(telegramPairTimer);
  telegramPairTimer = null;
  telegramPairing = null;
}
async function loadTelegram() {
  if (telegramLoading || !telegramOnline()) return;
  telegramLoading = true;
  telegramError = '';
  render();
  try {
    setTelegramStatus(await api('/telegram'));
  } catch (cause) {
    const error = requestError(cause);
    telegramError = error.message || String(error);
  } finally {
    telegramLoading = false;
    render();
  }
}
async function updateTelegram(kind: string, body?: unknown) {
  if (!telegramOnline()) throw Error(t('telegramOffline'));
  if (pendingActions.has('telegram') || (kind === 'forwarding' && telegramLoading)) return;
  let forwarding = null,
    expected = null,
    owner = null,
    tokenDraft = null;
  if (kind === 'forwarding') {
    const previous = telegramForwarding(),
      words = telegramForwardingCopy();
    if (!telegramForwardingOnline()) throw Error(t('telegramOffline'));
    if (!previous.supported) throw Error(words.update);
    if (
      !isRecord(body) ||
      !Object.keys(body).length ||
      Object.entries(body).some(([key, value]) =>
        key === 'forwardMode'
          ? value !== 'unread' && value !== 'all'
          : key === 'combineReplies'
            ? typeof value !== 'boolean'
            : true,
      )
    )
      throw Error(words.failed);
    forwarding = Object.fromEntries(
      Object.entries(body).filter(
        ([key, value]) =>
          (key === 'forwardMode'
            ? previous.forwardMode
            : key === 'combineReplies'
              ? previous.combineReplies
              : undefined) !== value,
      ),
    );
    if (!Object.keys(forwarding).length) return;
    expected = {
      forwardMode: previous.forwardMode,
      combineReplies: previous.combineReplies,
      ...forwarding,
    };
    owner = telegramSettingsScope();
    tokenDraft = document.querySelector<HTMLInputElement>('#telegram-token')?.value ?? null;
  }
  pendingActions.add('telegram');
  telegramError = '';
  if (kind === 'forwarding') renderTelegramForwardingChange(tokenDraft, owner);
  else render();
  try {
    if (kind === 'forwarding') {
      const result = await post('/telegram/config', forwarding);
      if (owner !== telegramSettingsScope()) return;
      const received = telegramForwarding(result);
      if (
        !received.supported ||
        received.forwardMode !== expected?.forwardMode ||
        received.combineReplies !== expected?.combineReplies
      )
        throw Error(telegramForwardingCopy().failed);
      setTelegramStatus(result, { preservePairing: true });
      toast(telegramForwardingCopy().saved);
    }
    if (kind === 'config') {
      setTelegramStatus(await post('/telegram/config', body));
      clearTelegramPairing();
      toast(t('telegramSaved'));
    }
    if (kind === 'pair') {
      const result = await post('/telegram/pair');
      clearTelegramPairing();
      telegramPairing = result;
      telegramPairTimer = setTimeout(
        () => {
          telegramPairing = null;
          telegramPairTimer = null;
          if (page === 'settings') render();
        },
        Math.max(0, result.expiresAt - Date.now()),
      );
    }
    if (kind === 'disconnect') {
      setTelegramStatus(await post('/telegram/disconnect', body));
      clearTelegramPairing();
      const secret = document.querySelector<HTMLInputElement>('#telegram-token');
      if (secret) secret.value = '';
      toast(t(isRecord(body) && body.clearToken ? 'telegramRemoved' : 'telegramUnbound'));
    }
  } catch (cause) {
    const error = requestError(cause);
    if (kind === 'forwarding') {
      if (owner !== telegramSettingsScope()) return;
      telegramError = telegramForwardingCopy().failed;
      throw Error(telegramError);
    }
    telegramError = error.message || String(error);
    throw error;
  } finally {
    pendingActions.delete('telegram');
    if (kind === 'forwarding') renderTelegramForwardingChange(tokenDraft, owner);
    else render();
  }
}
function bindTelegram() {
  const owner = telegramSettingsScope(),
    save = async (body: { forwardMode?: string; combineReplies?: boolean }) => {
      if (owner !== telegramSettingsScope() || telegramLoading || pendingActions.has('telegram'))
        return;
      const draft = document.querySelector<HTMLInputElement>('#telegram-token')?.value ?? null;
      try {
        await updateTelegram('forwarding', body);
      } catch (cause) {
        const error = requestError(cause);
        renderTelegramForwardingChange(draft, owner);
        toast(errorText(error));
      }
    };
  const forwarding = document.querySelector<HTMLSelectElement>('#telegram-forward-mode');
  if (forwarding) forwarding.onchange = () => save({ forwardMode: forwarding.value });
  const combine = document.querySelector<HTMLInputElement>('#telegram-combine-replies');
  if (combine) combine.onchange = () => save({ combineReplies: combine.checked });
  const form = document.querySelector<HTMLFormElement>('#telegram-token-form');
  if (!form) return;
  const input = document.querySelector<HTMLInputElement>('#telegram-token');
  if (!input) return;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    try {
      await updateTelegram('config', { token: input.value.trim() });
      input.value = '';
      const current = document.querySelector<HTMLInputElement>('#telegram-token');
      if (current) current.value = '';
    } catch (cause) {
      const error = requestError(cause);
      toast(errorText(error));
    }
  };
}
function renderVoiceSettings(settings: AppSettings) {
  const configured = voiceKeyConfigured(),
    busy = pendingActions.has('voice-key'),
    active = !!currentState().call || !!pc || callStarting,
    environment = currentState().worker.realtime?.key?.source === 'environment',
    nativeVoice = settings.nativeVoice || settings.voice || 'ember',
    apiVoice = settings.apiVoice || 'marin';
  const choices = (current: string, list: readonly string[]) =>
    [...new Set([current, ...list])]
      .filter(Boolean)
      .map(
        (voice) =>
          `<option value="${esc(voice)}" ${voice === current ? 'selected' : ''}>${esc(voice)}</option>`,
      )
      .join('');
  return `<section class="settings-section setting-card voice-settings"><div class="card-label"><h2>${t('call')}</h2></div><div class="card-content">${callCaptionPreferences.renderSetting()}<p class="voice-native-info">${t('voiceNativeInfo')}</p><div class="setting-row native-voice-setting"><div>${t('voice')}<small>${esc(subscriptionVoiceUnavailable() ? t('callUnavailable') : voiceError ? t(voiceError) : t('voiceSub'))}</small></div><select id="nativeVoice" aria-label="${t('voice')}" ${subscriptionVoiceUnavailable() || active ? 'disabled' : ''}>${choices(nativeVoice, voiceChoices)}</select></div><div class="voice-reference-links"><a href="https://learn.chatgpt.com/docs/features/voice" target="_blank" rel="noopener noreferrer">${t('voiceNativeDoc')}${ico('external-link')}</a><a href="https://learn.chatgpt.com/docs/pricing" target="_blank" rel="noopener noreferrer">${t('voiceNativePricing')}${ico('external-link')}</a></div><details class="voice-api-options" id="voice-api-options" ${voiceApiExpanded ? 'open' : ''}><summary>${t('voiceApiOptional')}</summary><div class="voice-api-content"><p class="voice-billing" id="voice-billing">${t('voiceBilling')}</p><div class="voice-key-status"><span class="key-state ${configured ? 'configured' : ''}">${configured ? ico('check') : ''}${t(configured ? 'voiceKeyConfigured' : 'voiceKeyMissing')}</span>${configured ? `<small>${t('voiceKeyValidation')}${environment ? ` ${t('voiceKeyEnvironment')}` : ''}</small>` : ''}</div><form id="voice-key-form" autocomplete="off"><label for="voice-api-key">${t('voiceKeyLabel')}<input id="voice-api-key" type="password" name="voiceKey" placeholder="sk-…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="voice-billing" required ${busy || active ? 'disabled' : ''}></label><div class="form-actions">${configured ? `<button type="button" class="text-btn" id="voice-key-remove" ${environment || busy || active ? 'disabled' : ''}>${t('voiceKeyRemove')}</button>` : ''}<button type="submit" class="text-btn primary" ${busy || active ? 'disabled' : ''}>${t(configured ? 'voiceKeyUpdate' : 'voiceKeySave')}</button></div></form><div class="voice-key-links"><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">${t('voiceKeyGet')}${ico('external-link')}</a><a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">${t('voiceKeyUsage')}${ico('external-link')}</a></div><div class="setting-row"><div>${t('voiceApiVoice')}<small>${esc(apiVoiceUnavailable() ? t('voiceApiRequired') : t('voiceApiHint'))}</small></div><select id="apiVoice" aria-label="${t('voiceApiVoice')}" ${apiVoiceUnavailable() || active ? 'disabled' : ''}>${choices(apiVoice, apiVoiceChoices)}</select></div><button type="button" class="text-btn" data-action="call-api" ${apiVoiceUnavailable() || active || !eventConnected || currentState().worker.status !== ConnectionStatus.Online ? 'disabled' : ''}>${ico('phone')}${t('voiceApiStart')}</button></div></details></div></section>`;
}
function renderProvisionCard() {
  const current = currentState().provisioning || { status: 'idle' },
    busy =
      current.running ??
      hasValue(
        [
          ProvisioningStatus.Preparing,
          ProvisioningStatus.AwaitingAdmin,
          ProvisioningStatus.Creating,
          ProvisioningStatus.Installing,
        ],
        current.status,
      ),
    ready = current.status === ProvisioningStatus.Ready,
    existing = !!currentState().settings.vm.host || !!current.connection,
    selection = provisionDraft.provider || 'auto',
    detected = vmProviderStatus(),
    provider = existing ? vmConfiguredProvider() : detected.provider;
  const phases = [
      'preparing',
      ...(provider === 'hyperv' || current.status === ProvisioningStatus.AwaitingAdmin
        ? ['awaiting-admin']
        : []),
      'creating',
      'installing',
      'ready',
    ],
    rank = phases.indexOf(current.status),
    availability = detected.availableProviders.find((item) => item.id === selection),
    unavailable =
      selection === 'auto'
        ? detected.availableProviders.length > 0 &&
          !detected.availableProviders.some((item) => item.available)
        : availability?.available === false;
  const providerOptions = ['auto', 'hyperv', 'vmware']
    .map((id) => {
      const item = detected.availableProviders.find((entry) => entry.id === id);
      return `<option value="${id}" ${selection === id ? 'selected' : ''} ${item?.available === false ? 'disabled' : ''}>${esc(vmProviderLabel(id))}</option>`;
    })
    .join('');
  const providerHint =
    provider === 'vmware'
      ? 'providerVmwareHint'
      : provider === 'hyperv'
        ? 'providerHypervHint'
        : 'providerAutoHint';
  return `<div class="provision-card"><p class="setup-summary">${existing ? esc(vmSystemDescription()) : t('newComputerSystem')}</p><p class="setup-lead">${ready ? t('setupReady') : busy ? setupStageText(current) : t(existing ? 'existingComputerConfigured' : 'setupBeforeCreate')}</p>${current.status === ProvisioningStatus.Failed ? `<p class="error">${esc(current.error ? errorText(current.error) : t('provisionFailed'))}</p>` : ''}${busy || ready ? `<ol class="setup-phases">${phases.map((phase, index) => `<li class="${index < rank || ready ? 'done' : index === rank ? 'current' : ''}"><span>${index < rank || ready ? ico('check') : index + 1}</span>${t(phase === 'ready' ? 'provisionReady' : phase)}</li>`).join('')}</ol>` : ''}${existing ? `<div class="setup-connection"><strong>${t('connectionDetails')}</strong><span>${esc(currentState().settings.vm.user || current.connection?.user || 'dant')}@${esc(currentState().settings.vm.host || current.connection?.host || '')}</span></div>` : ''}<form id="provision-form"><label>${t('hypervisor')}<select name="provider" aria-label="${t('hypervisor')}" ${busy || existing || vmProvidersBusy ? 'disabled' : ''}>${providerOptions}</select></label>${vmProvidersBusy ? `<p class="muted" role="status">${t('providerDetecting')}</p>` : ''}${vmProvidersError ? `<p class="error">${esc(errorText(vmProvidersError))}</p>` : ''}${provider ? `<p class="muted">${t('providerUsing')} · ${esc(vmProviderLabel(provider))}</p>` : ''}<p class="muted">${t(providerHint)}</p>${unavailable ? `<p class="error">${t(selection === 'auto' ? 'noHypervisor' : 'providerUnavailable')}${availability?.reason ? ' · ' + esc(errorText(availability.reason)) : ''}</p>` : ''}<details id="provision-options" ${provisionExpanded ? 'open' : ''}><summary>${t('createOptions')}</summary><div class="provision-resources"><label>${t('cpu')}<input name="cpu" type="number" min="${COMPUTER_RESOURCES.cpu.min}" max="${COMPUTER_RESOURCES.cpu.max}" value="${esc(provisionDraft.cpu)}" required ${busy || existing ? 'disabled' : ''}></label><label>${t('memorySize')}<input name="memoryGB" type="number" min="${COMPUTER_RESOURCES.memoryGB.min}" max="${COMPUTER_RESOURCES.memoryGB.max}" value="${esc(provisionDraft.memoryGB)}" required ${busy || existing ? 'disabled' : ''}></label><label>${t('diskSize')}<input name="diskGB" type="number" min="${COMPUTER_RESOURCES.diskGB.min}" max="${COMPUTER_RESOURCES.diskGB.max}" value="${esc(provisionDraft.diskGB)}" required ${busy || existing ? 'disabled' : ''}></label></div><label class="provision-admin"><input name="adminSudo" type="checkbox" ${provisionDraft.adminSudo ? 'checked' : ''} ${busy || existing ? 'disabled' : ''}><span>${t('vmAdmin')}<small>${t('vmAdminHint')}</small></span></label></details><div class="setup-footer">${existing ? button('connect', 'refresh-cw', t('refresh'), 'text-btn') : ''}<button type="submit" class="text-btn primary" ${busy || existing || vmProvidersBusy || unavailable ? 'disabled' : ''}>${t(existing ? 'createReady' : busy ? current.status : 'createComputer')}</button>${ready ? button('setup-done', 'arrow-up', t('backChat'), 'text-btn') : ''}</div></form></div>`;
}
function renderMemory() {
  return memorySettings.render();
}
function renderSchedules() {
  return scheduledTasks.renderPage();
}
function renderCallReady() {
  const ready =
    eventConnected &&
    currentState().worker.status === ConnectionStatus.Online &&
    !subscriptionVoiceUnavailable() &&
    !currentState().call &&
    !callStops.pending;
  return `<div class="call-ready" data-key="call-ready"><div class="call-ready-top">${button('text-mode', 'arrow-left', t('backChat'), 'text-btn back-button')}<span>${t('voiceMode')}</span></div><div class="call-ready-center">${eyes('call-avatar')}<p>${t('callReady')}</p>${callDuration.snapshot.finalized && !currentState().call && !callStops.pending ? `<small class="last-call-duration">${t('callEnded')} · ${formatCallDuration(callDuration.snapshot.seconds)}</small>` : ''}</div><div class="call-ready-bottom"><button type="button" class="call-start" data-action="call" ${ready ? '' : 'disabled'} title="${t('startCall')}" aria-label="${t('startCall')}">${ico('phone')}</button>${!ready ? `<p>${t(currentState().call || callStops.pending ? 'callNeedsStop' : subscriptionVoiceUnavailable() ? 'callUnavailable' : 'setupHint')}</p><button type="button" class="text-link" data-action="${currentState().call || callStops.pending ? 'hangup' : 'voice-settings'}">${t(currentState().call || callStops.pending ? 'hangup' : subscriptionVoiceUnavailable() ? 'voiceSettings' : 'settings')}</button>` : ''}</div></div>`;
}
function updateCallDuration() {
  for (const node of document.querySelectorAll<HTMLButtonElement>('[data-call-duration]'))
    node.textContent = formatCallDuration(callDuration.snapshot.seconds);
  publishCallOverlay();
}
function renderCall() {
  if (!pc && !callStarting && !currentState().call && !callStops.pending) return '';
  const recovering = !pc && !callStarting,
    provider = currentState().call?.provider || callProvider;
  return `<div data-key="call-view" class="call-view ${callMini ? 'mini' : ''}"><div class="call-top"><span>${callMini ? 'dant' : t('voiceMode')}</span>${button('call-size', callMini ? 'maximize-2' : 'minimize-2', t(callMini ? 'expandCall' : 'minimizeToChat'), 'icon-btn call-size-toggle')}</div>${eyes('call-avatar')}${provider === 'api' ? `<small class="call-provider">${t('voiceApiActive')}</small>` : ''}<p>${t(recovering ? (callStops.pending ? 'callPendingStop' : 'callRecover') : callConnected && pc?.connectionState === 'connected' && callChannel?.readyState === 'open' ? 'talking' : 'calling')}</p>${callDuration.snapshot.confirmed ? `<span class="call-duration" data-call-duration aria-label="${t('callDuration')}">${formatCallDuration(callDuration.snapshot.seconds)}</span>` : ''}${callSubtitles.render({ mini: callMini, language: language(), enabled: callCaptionPreferences.enabled })}<div class="call-controls">${callCaptionPreferences.renderToggle({ mini: callMini })}${stream ? button('mute', callMuted ? 'mic-off' : 'mic', t(callMuted ? 'unmute' : 'mute'), 'icon-btn ' + (callMuted ? 'muted-mic' : '')) : ''}${button('hangup', 'phone', t('hangup'), 'icon-btn hangup')}</div></div>`;
}
function publishCallOverlay() {
  const currentCall = state?.call,
    clock = callDuration.snapshot,
    id =
      callId || state?.call?.id || state?.call?.callId || (callStops.pending ? clock.callId : null);
  if (!id || (!pc && !callStarting && !state?.call && !callStops.pending)) {
    nativeCallOverlay.update(null);
    return;
  }
  const connected =
      callConnected && pc?.connectionState === 'connected' && callChannel?.readyState === 'open',
    recovering = !pc && !callStarting,
    matching = state?.call?.id === id || state?.call?.callId === id;
  nativeCallOverlay.update({
    callId: id,
    status: callStops.pending
      ? 'stopping'
      : recovering
        ? 'recovering'
        : connected
          ? 'talking'
          : 'calling',
    connectedAt:
      matching &&
      typeof currentCall?.connectedAt === 'number' &&
      Number.isFinite(currentCall.connectedAt)
        ? currentCall.connectedAt
        : null,
    seconds: clock.seconds,
    confirmed: clock.confirmed,
    running: clock.running,
    muted: callMuted,
    canMute: Boolean(stream) && !callStops.pending,
    language: language(),
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  });
}
async function handleNativeCallAction(value: unknown) {
  const id =
    callId ||
    state?.call?.id ||
    state?.call?.callId ||
    (callStops.pending ? callDuration.snapshot.callId : null);
  if (
    unloading ||
    !isRecord(value) ||
    value.callId !== id ||
    typeof value.action !== 'string' ||
    !['mute', 'hangup', 'restore'].includes(value.action)
  )
    return;
  if (value.action === 'restore') return; // Native code restores the existing main window.
  if (
    value.action === 'mute' &&
    (!stream || callStops.pending || typeof value.muted !== 'boolean' || callMuted === value.muted)
  )
    return;
  await action(value.action);
}
function renderUnconfirmedMessage() {
  const uncertain = messageSubmissions.unknown;
  return uncertain
    ? `<div class="unconfirmed-send" role="status"><strong>${t('sendUnknown')}</strong><p>${t('sendUnknownHint')}</p><small>${uncertain.kind === 'voice' ? t('sendVoice') : esc(uncertain.payload.text.slice(0, 140))}</small><div><button type="button" class="text-btn" data-action="check-send">${t('checkSend')}</button><button type="button" class="text-btn" data-action="confirm-resend" ${sending ? 'disabled' : ''}>${t('confirmResend')}</button></div></div>`
    : '';
}
function conversationFiles() {
  const files = new Map<string, ConversationFile>();
  for (const message of currentState().messages)
    for (const file of message.attachments || [])
      files.set(file.id, {
        ...file,
        role: message.role,
        ...(message.time === undefined ? {} : { time: message.time }),
      });
  return [...files.values()];
}
const outputLinkRecoveries = new Map<string, Promise<Attachment | null>>();
function outputLinkScope() {
  const vm = state?.settings?.vm;
  return JSON.stringify([
    state?.conversationId ?? null,
    vm?.host ?? null,
    vm?.user ?? null,
    vm?.port ?? null,
    vm?.keyPath ?? null,
    page,
  ]);
}
function resolveMessageOutputLink({
  messageId,
  href,
}: {
  messageId: string;
  href: string | null;
}): Promise<Attachment | null> {
  const scope = outputLinkScope(),
    conversationId = state?.conversationId,
    message = state?.messages.find((item) => item.id === messageId),
    text = message?.text,
    key = JSON.stringify([scope, messageId, href]);
  const existing = outputLinkRecoveries.get(key);
  if (existing) return existing;
  if (
    !eventConnected ||
    state?.controller?.cached === true ||
    (state?.controller && currentState().controller?.status !== ConnectionStatus.Online) ||
    !conversationId ||
    message?.role !== 'assistant'
  )
    return Promise.reject(
      Error(
        translate(
          language(),
          'Reconnect the original work computer and try this file again.',
          '请连接原工作电脑后重试这个文件。',
        ),
      ),
    );
  const operation = post('/messages/' + encodeURIComponent(messageId) + '/output-link/resolve', {
    conversationId,
    href,
  })
    .then((result) => {
      if (outputLinkScope() !== scope) return null;
      const current = currentState().messages.find((item) => item.id === messageId);
      if (
        current?.role !== 'assistant' ||
        current.text !== text ||
        !isRecord(result) ||
        result.conversationId !== conversationId ||
        result.messageId !== messageId ||
        !isRecord(result.attachment) ||
        typeof result.attachment.id !== 'string'
      )
        return null;
      const recovered = attachmentSnapshot(result.attachment);
      current.attachments = (current.attachments || []).some((file) => file.id === recovered.id)
        ? (current.attachments || []).map((file) => (file.id === recovered.id ? recovered : file))
        : [...(current.attachments || []), recovered];
      render();
      return recovered;
    })
    .finally(() => {
      if (outputLinkRecoveries.get(key) === operation) outputLinkRecoveries.delete(key);
    });
  outputLinkRecoveries.set(key, operation);
  return operation;
}
function renderProgress() {
  const model = workProgress(state, { language: language(), connected: eventConnected }),
    { active, queue, ongoing, history } = model;
  const recent = model.recent || history.filter((entry) => entry.status !== TaskStatus.Completed),
    completed = model.completed || [],
    busy = progressActions.busy || !model.reliable;
  const taskActions = (message: ProgressMessage, status: TaskStatusValue) => {
    const pending = busy || pendingActions.has('task:' + message.id),
      unknown = unknownTask(message),
      resumeBlocked = currentState().call?.provider === 'subscription';
    return `${unknown ? `<div class="unknown-outcome"><strong>${t('unknownOutcome')}</strong><p>${t('unknownHint')}</p></div>` : ''}${status === TaskStatus.Review ? `<div class="task-actions"><button type="button" class="text-btn" data-task-accept="${esc(message.id)}" ${pending ? 'disabled' : ''}>${t('acceptTask')}</button></div>` : hasValue([TaskStatus.Paused, TaskStatus.Failed], status || '') ? `<div class="task-actions"><button type="button" class="text-btn" ${unknown ? 'data-task-unknown' : 'data-task-resume'}="${esc(message.id)}" ${pending || humanControl() || resumeBlocked ? 'disabled' : ''} ${resumeBlocked ? `title="${t('resumeAfterCall')}"` : ''}>${t(unknown ? 'confirmRepeat' : 'resumeTask')}</button>${resumeBlocked ? `<small>${t('resumeAfterCall')}</small>` : ''}</div>` : ''}`;
  };
  const item = (message: ProgressMessage | undefined, status: TaskStatusValue) => {
    if (!message) return '';
    return renderMessageItem(message, status);
  };
  const renderMessageItem = (message: ProgressMessage, status: TaskStatusValue) => {
    const pending = busy || pendingActions.has('task:' + message.id);
    const dismiss = hasValue(
      [
        TaskStatus.Review,
        TaskStatus.Paused,
        TaskStatus.Failed,
        TaskStatus.Completed,
        TaskStatus.Cancelled,
      ],
      status || '',
    )
      ? `<button type="button" class="icon-btn progress-dismiss" data-task-dismiss="${esc(message.id)}" data-progress-kind="task" data-progress-status="${esc(status)}" title="${t('dismissTask')}" aria-label="${t('dismissTask')}" ${pending ? 'disabled' : ''}>${ico('x')}</button>`
      : '';
    return `<div class="progress-item" data-key="progress-${esc(message.id)}"><span class="progress-state ${status}">${status === TaskStatus.Completed ? ico('check') : ico('clock')}</span><div><p>${esc(message.text || message.attachments?.map((file) => file.name).join(', ') || '')}</p><small>${t(status)} · ${formatTime(message.time, true)}</small>${renderWorkPriority({ message, status }, model.labels, { pending })}${taskActions(message, status)}${progressActions.renderConfirmation({ id: message.id, kind: 'task' })}</div>${dismiss}</div>`;
  };
  const historyItem = (entry: ProgressItem) =>
    entry.registered
      ? renderWorkTaskHistory(entry, model.labels, {
          pending:
            busy ||
            pendingActions.has('task:' + entry.id) ||
            pendingActions.has('task:' + entry.taskId),
          actions:
            entry.message && (entry.status === TaskStatus.Review || unknownTask(entry.message))
              ? taskActions(entry.message, entry.status)
              : '',
          planOpen: Boolean(entry.id && workDisclosures.isOpen(entry.id)),
          confirmation: progressActions.renderConfirmation(
            entry.cancelTarget || { id: entry.id, kind: 'work' },
          ),
        })
      : entry.voice
        ? renderVoiceWorkHistory(entry, model.labels, {
            pending: busy || pendingActions.has('task:' + entry.id),
            confirmation: progressActions.renderConfirmation({ id: entry.id, kind: 'completion' }),
          })
        : item(entry.message, entry.status);
  const ongoingHtml = ongoing.length
    ? `<h4>${esc(model.labels.ongoing)}</h4>${ongoing.map(historyItem).join('')}`
    : '';
  const completedHtml = model.completedCount
    ? `<div class="progress-section-heading"><h4>${esc(model.labels.completedTasks)} <small>(${model.completedCount})</small></h4><button type="button" class="text-btn" data-progress-clear-completed aria-label="${esc(model.labels.completedTasks + ': ' + model.labels.clearCompleted)}" ${busy ? 'disabled' : ''}>${esc(model.labels.clearCompleted)}</button></div>${completed.slice(0, 12).map(historyItem).join('')}`
    : '';
  return `<div data-key="progress-window"${model.nextExpiryAt ? ` data-progress-expires-at="${model.nextExpiryAt}"` : ''}>${active ? renderActiveWork(model, { pending: busy, planOpen: Boolean(active.id && workDisclosures.isOpen(active.id)), confirmation: progressActions.renderConfirmation(active.cancelTarget || { id: active.id, kind: active.registered ? 'work' : 'task' }) }) : ongoing.length ? '' : `<p class="muted">${model.reliable ? t('noActiveTask') : esc(model.labels.offline)}</p>`}${ongoingHtml}${queue.length ? `<h4>${t('queuedTasks')}</h4>${queue.map((entry) => item(entry.message, 'queued')).join('')}` : ''}${recent.length ? `<h4>${t('taskHistory')}</h4>${recent.map(historyItem).join('')}` : ''}${completedHtml}${!active && !ongoing.length && !queue.length && !recent.length && !model.completedCount ? `<p class="muted">${t('progressEmpty')}</p>` : ''}</div>`;
}
function renderModal() {
  if (!modal) return '';
  const managed =
    managedSettings.renderModal(modal) ??
    chatHistory.renderModal(modal) ??
    chatCollections.renderModal(modal);
  if (managed !== null) return managed;
  if (modal.type === 'task-detail') return taskDetails.renderModal(modal);
  if (modal.type === 'file') return filePreview.renderModal(modal);
  if (modal.type === 'image') {
    const file =
      conversationFiles().find((item) => item.id === modal?.fileId) ||
      (typeof taskDetails === 'undefined' ? null : taskDetails.file(modal.fileId));
    if (!file) return '';
    return `<div class="modal-backdrop image-backdrop" data-key="modal-backdrop"><section class="dialog image-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><h2 id="dialog-title">${esc(file.name)}</h2><div><button type="button" class="icon-btn" data-download="${esc(file.id)}" aria-label="${t('download')}">${ico('download')}</button>${button('close-modal', 'x', t('close'))}</div></div><div class="image-preview-body"><img src="${fileURL(file)}" alt="${esc(file.name)}"></div></section></div>`;
  }
  const setup = modal.type === 'setup',
    files = conversationFiles();
  return `<div class="modal-backdrop" data-key="modal-backdrop"><section class="dialog ${setup ? 'setup-dialog' : 'details-dialog'}" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><h2 id="dialog-title">${t(setup ? 'setupDetails' : 'details')}</h2>${button('close-modal', 'x', t('close'))}</div><div class="dialog-body">${setup ? renderProvisionCard() : `<div class="details-actions"><button type="button" class="text-btn" data-chat-search title="${esc(chatSearchLabel())}" aria-label="${esc(chatSearchLabel())}">${ico('search')}<span>${esc(chatSearchLabel())}</span></button>${button('progress', 'clock', t('progress'), 'text-btn')}</div><p class="details-caption">dant · ${currentState().messages.length ? formatTime(currentState().messages.at(-1)?.time, true) : t('ready')}</p><h3>${t('files')}</h3><div class="details-files">${files.length ? files.map((file) => `<div class="details-file" data-id="${esc(file.id)}"><div>${ico(String(file.type).startsWith('audio/') ? 'volume-2' : 'file-text')}<div>${String(file.type).startsWith('image/') ? `<button type="button" class="file-name" data-preview="${esc(file.id)}">${esc(file.name)}</button>` : canPreviewFile(file) ? `<button type="button" class="file-name" data-file-preview="${esc(file.id)}">${esc(file.name)}</button>` : `<button type="button" class="file-name" data-download="${esc(file.id)}">${esc(file.name)}</button>`}<small>${t(file.role === 'assistant' ? 'fileDelivered' : 'fileShared')} · ${Math.max(1, Math.round((file.size || 0) / 1024))} KB</small></div></div><button type="button" class="icon-btn" data-download="${esc(file.id)}" aria-label="${t('download')}">${ico('download')}</button></div>`).join('') : `<p class="muted">${t('filesEmpty')}</p>`}</div>`}</div></section></div>`;
}
function openModal(value: UiModal) {
  if (value.type === 'progress') {
    openProgress();
    return;
  }
  if (modal?.type === 'credential' && (value.type !== 'credential' || value.key !== modal.key))
    managedSettings.onClose(modal);
  if (modal && ['image', 'file'].includes(value.type)) {
    const parent = modal.type === 'file' ? modal.parent : modal;
    if (parent) value.parent = parent;
    else delete value.parent;
  } else modalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal = value;
  emojiFor = null;
  render();
  document.querySelector<HTMLElement>('.dialog')?.focus({ preventScroll: true });
}
function closeModal() {
  managedSettings.onClose(modal);
  chatHistory.onClose();
  chatCollections.onClose();
  progressActions.onClose();
  if (modal?.parent) {
    modal = modal.parent;
    render();
    document.querySelector<HTMLElement>('.dialog')?.focus({ preventScroll: true });
    return;
  }
  modal = null;
  render();
  if (modalFocus?.isConnected) modalFocus.focus({ preventScroll: true });
  modalFocus = null;
}
function resizeComposer() {
  const input = document.querySelector<HTMLTextAreaElement>('#composer');
  if (input) {
    input.style.height = 'auto';
    input.style.height = Math.min(130, input.scrollHeight) + 'px';
  }
}
function renderLoginDetails() {
  return loginDetails
    ? `<div class="login-card"><strong>${esc(loginDetails.userCode)}</strong><a href="${esc(loginDetails.verificationUrl)}" target="_blank" rel="noopener noreferrer">${esc(loginDetails.verificationUrl)}</a></div>`
    : '';
}
function formVM(form: HTMLFormElement) {
  const data = new FormData(form);
  const value = (name: string): string => {
    const result = data.get(name);
    if (typeof result !== 'string') throw Error('Invalid VM form');
    return result;
  };
  return {
    host: value('host'),
    user: value('user'),
    port: Number(value('port')),
    keyPath: value('keyPath'),
  };
}
async function saveVM() {
  const form = document.querySelector<HTMLFormElement>('#vm-form');
  if (!form?.reportValidity()) return false;
  const vm = formVM(form);
  await api('/settings', { method: 'PATCH', body: { vm } });
  currentState().settings.vm = { ...currentState().settings.vm, ...vm };
  vmDraft = null;
  return true;
}
let inputChain: Promise<unknown> = Promise.resolve();
function vmInput(input: Record<string, unknown>) {
  const sessionId = currentState().computer?.sessionId;
  inputChain = inputChain
    .catch(() => {})
    .then(() => {
      if (!computerInputReady())
        throw Error(
          t(
            !computerExecutorReady()
              ? 'agentOfflineControl'
              : !humanControl()
                ? 'offline'
                : 'callControlBusy',
          ),
        );
      if (sessionId !== currentState().computer?.sessionId) throw Error(t('connectionChanged'));
      return post('/input', { ...input, sessionId });
    })
    .catch((error) => toast(errorText(error)));
  return inputChain;
}
function bind() {
  messageWindow.bind(document.querySelector<HTMLElement>('#messages'), () => {
    if (messageWindow.loadOlder(currentState().messages, messageHistoryScope(state))) render();
  });
  workDisclosures.bind();
  document
    .querySelectorAll<HTMLButtonElement>('[data-action]')
    .forEach(
      (el) =>
        (el.onclick = () => action(requiredData(el, 'action')).catch((e) => toast(errorText(e)))),
    );
  const composer = document.querySelector<HTMLTextAreaElement>('#composer');
  if (composer) {
    composer.oninput = () => {
      composerDraft = composer.value;
      resizeComposer();
    };
    composer.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        send().catch((e) => toast(errorText(e)));
      }
    };
  }
  const messageForm = document.querySelector<HTMLFormElement>('#message-form');
  if (messageForm)
    messageForm.onsubmit = (e) => {
      e.preventDefault();
      send().catch((e) => toast(errorText(e)));
    };
  document.querySelectorAll<HTMLButtonElement>('[data-reply]').forEach(
    (el) =>
      (el.onclick = () => {
        replyTo = el.dataset.reply ?? null;
        render();
        document.querySelector<HTMLTextAreaElement>('#composer')?.focus();
      }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-react]').forEach(
    (el) =>
      (el.onclick = async () => {
        const id = el.dataset.react,
          emoji = el.dataset.emoji;
        emojiFor = null;
        render();
        await post('/messages/' + id + '/reaction', { emoji }).catch((error) =>
          toast(errorText(error)),
        );
      }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-picker]').forEach(
    (el) =>
      (el.onclick = () => {
        emojiFor = emojiFor === el.dataset.picker ? null : (el.dataset.picker ?? null);
        render();
      }),
  );
  document
    .querySelectorAll<HTMLButtonElement>('[data-preview]')
    .forEach(
      (el) =>
        (el.onclick = () => openModal({ type: 'image', fileId: requiredData(el, 'preview') })),
    );
  bindAttachmentImages(document, {
    ready:
      eventConnected &&
      (!currentState().controller ||
        (currentState().controller?.status === ConnectionStatus.Online &&
          currentState().controller?.cached !== true)),
    scope: JSON.stringify([
      currentState().conversationId ?? null,
      currentState().settings?.vm?.host ?? null,
      currentState().settings?.vm?.user ?? null,
      currentState().settings?.vm?.port ?? null,
      currentState().settings?.vm?.keyPath ?? null,
    ]),
  });
  filePreview.bind(
    (id) =>
      conversationFiles().find((file) => file.id === id) ||
      (typeof taskDetails === 'undefined' ? null : taskDetails.file(id)),
  );
  downloads.bind(
    (id) =>
      conversationFiles().find((file) => file.id === id) ||
      (typeof taskDetails === 'undefined' ? null : taskDetails.file(id)),
    () =>
      toast(
        translate(
          language(),
          'Could not save the file. Check the connection and destination, then try again.',
          '文件保存失败，请检查连接和保存位置后重试。',
        ),
      ),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-progress-message]').forEach(
    (node) =>
      (node.onclick = () => {
        const id = node.dataset.progressMessage;
        if (!currentState().messages.some((message) => message.id === id)) return;
        closeModal();
        revealMessage(id);
        const target = [...document.querySelectorAll<HTMLElement>('.message[data-id]')].find(
          (element) => element.dataset.id === id,
        );
        if (target) {
          chatScroll.navigate(() => target.scrollIntoView({ block: 'center', behavior: 'auto' }));
          target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }
        updateRead();
      }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-first-unread]').forEach(
    (node) =>
      (node.onclick = () => {
        const first = unreadMessages()[0];
        if (!first) return;
        revealMessage(first.id);
        const target = [...document.querySelectorAll<HTMLElement>('.message[data-id]')].find(
          (element) => element.dataset.id === first.id,
        );
        if (target) {
          chatScroll.navigate(() => target.scrollIntoView({ block: 'center', behavior: 'auto' }));
          target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }
        updateRead();
      }),
  );
  document
    .querySelectorAll<HTMLSelectElement>('select[data-language]')
    .forEach(
      (el) =>
        (el.onchange = () => changeLanguage(el.value).catch((error) => toast(errorText(error)))),
    );
  document.querySelectorAll<HTMLButtonElement>('[data-permission]').forEach(
    (el) =>
      (el.onclick = () => {
        provisionDraft.adminSudo = el.dataset.permission === 'admin';
        render();
      }),
  );
  const manualOptions = document.querySelector<HTMLDetailsElement>('#manual-vm-options');
  if (manualOptions) manualOptions.ontoggle = () => (manualVMExpanded = manualOptions.open);
  const backdrop = document.querySelector<HTMLElement>('.modal-backdrop');
  if (backdrop)
    backdrop.onclick = (event) => {
      if (event.target === backdrop) closeModal();
    };
  document.querySelectorAll<HTMLButtonElement>('[data-retry]').forEach(
    (el) =>
      (el.onclick = () => {
        const message = currentState().messages.find((item) => item.id === el.dataset.retry);
        if (!message || message.status === TaskStatus.Cancelled) return;
        if (unknownTask(message)) {
          openProgress();
          return;
        }
        resumeTask(message.id, false).catch((error) => toast(errorText(error)));
      }),
  );
  document
    .querySelectorAll<HTMLButtonElement>('[data-task-resume]')
    .forEach(
      (el) =>
        (el.onclick = () =>
          resumeTask(requiredData(el, 'taskResume'), false).catch((error) =>
            toast(errorText(error)),
          )),
    );
  document
    .querySelectorAll<HTMLButtonElement>('[data-task-unknown]')
    .forEach(
      (el) =>
        (el.onclick = () =>
          resumeTask(requiredData(el, 'taskUnknown'), true).catch((error) =>
            toast(errorText(error)),
          )),
    );
  progressActions.bind();
  progressPanel.bind();
  taskReplies.bind();
  if (
    modal?.type === 'task-detail' ||
    document.querySelector<HTMLButtonElement>('[data-task-details],[data-task-detail-open]')
  )
    taskDetails.bind();
  document
    .querySelectorAll<HTMLButtonElement>('[data-task-accept]')
    .forEach(
      (el) =>
        (el.onclick = () =>
          taskRequest(
            requiredData(el, 'taskAccept'),
            '/tasks/' + encodeURIComponent(requiredData(el, 'taskAccept')) + '/accept',
          ).catch((error) => toast(errorText(error)))),
    );
  bindSteer();
  document.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(
    (el) =>
      (el.onclick = () => {
        attachments = attachments.filter((a) => a.id !== el.dataset.remove);
        render();
      }),
  );
  const fileInput = document.querySelector<HTMLInputElement>('#file-input');
  if (fileInput)
    fileInput.onchange = async () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = '';
      for (const file of files) await upload(file).catch((error) => toast(errorText(error)));
    };
  for (const key of ['model', 'nativeVoice', 'apiVoice', 'notifications'] as const) {
    const input = document.querySelector<HTMLInputElement | HTMLSelectElement>('#' + key);
    if (input)
      input.onchange = async () => {
        try {
          const value =
            key === 'notifications' && input instanceof HTMLInputElement
              ? input.checked
              : input.value;
          if (key === 'notifications' && value && !(await requestNotifications()))
            throw Error(t('notificationsDenied'));
          await api('/settings', { method: 'PATCH', body: { [key]: value } });
        } catch (error) {
          render();
          toast(errorText(error));
        }
      };
  }
  const workSummarySetting = document.querySelector<HTMLInputElement>('#showWorkSummary');
  if (workSummarySetting)
    workSummarySetting.onchange = async () => {
      const key = 'setting:showWorkSummary';
      if (pendingActions.has(key)) return;
      const enabled = workSummarySetting.checked;
      pendingActions.add(key);
      workSummarySetting.disabled = true;
      try {
        await api('/settings', { method: 'PATCH', body: { showWorkSummary: enabled } });
        currentState().settings.showWorkSummary = enabled;
      } catch (cause) {
        const error = requestError(cause);
        toast(errorText(error));
      } finally {
        pendingActions.delete(key);
        render();
      }
    };
  bindProvision();
  bindVoiceKey();
  callCaptionPreferences.bind();
  bindTelegram();
  bindAppearance();
  bindVMSettings();
  managedSettings.bind();
  if (document.querySelector<HTMLElement>('.vm-backups')) vmBackups.bind();
  chatHistory.bind();
  chatCollections.bind();
  if (modal) chatHistory.bindModal(modal);
  if (document.querySelector<HTMLElement>('.app-about-settings')) appUpdates.bind();
  if (document.querySelector<HTMLElement>('.memory-page')) memorySettings.bind();
  if (document.querySelector<HTMLElement>('.settings-layout')) {
    settingsNavigation.bind();
    if (settingsNavigation.isVisible('general')) textEditor.bind();
    if (settingsNavigation.isVisible('usage')) usageActivity.bind();
  }
  const callView = document.querySelector<HTMLElement>('.call-view');
  if (callView) callView.onclick = () => audio?.play().catch(() => {});
  if (document.querySelector<HTMLElement>('.schedules-page')) scheduledTasks.bind();
  workspaceLayout.bind();
  bindComputerInput();
  document
    .querySelectorAll<HTMLAnchorElement>(
      '.markdown a,#login-details a,.voice-settings a,.telegram-settings a',
    )
    .forEach((link) => {
      link.onclick = null;
      if (
        bindMessageAttachmentLink(link, {
          getMessage: (id) => currentState().messages.find((message) => message.id === id),
          onResolve: resolveMessageOutputLink,
          getScope: outputLinkScope,
          getModal: () => modal,
          onImage: (file) => openModal({ type: 'image', fileId: file.id }),
          onFile: (file) => filePreview.open(file),
          onDownload: (file) => downloads.save(file),
          onUnavailable: () =>
            toast(
              translate(
                language(),
                'This local file could not be restored. Check its output file on the original work computer.',
                '这个本地文件暂时无法恢复，请检查原工作电脑中的输出文件。',
              ),
            ),
          onError: (error) => toast(errorText(error)),
        })
      )
        return;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (window.__TAURI_INTERNALS__)
        link.onclick = (e) => {
          e.preventDefault();
          openExternal(link.href).catch((error) => toast(errorText(error)));
        };
    });
}
async function taskRequest(id: string, route: string, body: unknown = {}) {
  const key = 'task:' + id;
  if (pendingActions.has(key)) return;
  pendingActions.add(key);
  render();
  try {
    const result = await post(route, body);
    state = await api('/state');
    return result;
  } catch (cause) {
    const error = requestError(cause);
    if (route.endsWith('/cancel'))
      try {
        state = await api('/state');
      } catch {}
    throw error;
  } finally {
    pendingActions.delete(key);
    render();
  }
}
function resumeTask(id: string, confirmUnknown: boolean) {
  const message = currentState().messages.find((item) => item.id === id);
  if (!message || message.status === TaskStatus.Cancelled) return Promise.resolve();
  if (currentState().call?.provider === 'subscription') {
    toast(t('resumeAfterCall'));
    return Promise.resolve();
  }
  if (unknownTask(message) && !confirmUnknown) {
    openProgress();
    return Promise.resolve();
  }
  return taskRequest(id, '/tasks/resume', {
    ids: [id],
    ...(confirmUnknown ? { confirmUnknown: true } : {}),
  });
}
function bindSteer() {
  const form = document.querySelector<HTMLFormElement>('#steer-form');
  if (!form) return;
  const input = document.querySelector<HTMLTextAreaElement>('#steer-text');
  if (!input) return;
  input.oninput = () => {
    steerDraft = input.value;
    if (!steerDraft.trim()) steerExpectedTurn = null;
    else if (!steerExpectedTurn) steerExpectedTurn = currentState().active?.turnId ?? null;
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pendingActions.has('steer')) return;
    const text = input.value.trim(),
      expectedTurnId = steerExpectedTurn || currentState().active?.turnId;
    if (!text || !expectedTurnId) return;
    if (expectedTurnId !== currentState().active?.turnId) {
      toast(t('steerChanged'));
      return;
    }
    pendingActions.add('steer');
    render();
    try {
      await post('/steer', { text, expectedTurnId, ...(replyTo ? { replyTo } : {}) });
      steerDraft = '';
      steerExpectedTurn = null;
      const current = document.querySelector<HTMLTextAreaElement>('#steer-text');
      if (current) current.value = '';
      state = await api('/state');
    } catch (cause) {
      const error = requestError(cause);
      toast(errorText(error));
    } finally {
      pendingActions.delete('steer');
      render();
    }
  };
}
function bindVoiceKey() {
  const options = document.querySelector<HTMLDetailsElement>('#voice-api-options');
  if (options)
    options.ontoggle = () => {
      voiceApiExpanded = options.open;
      if (!options.open) {
        const secret = document.querySelector<HTMLInputElement>('#voice-api-key');
        if (secret) secret.value = '';
      }
    };
  const form = document.querySelector<HTMLFormElement>('#voice-key-form');
  if (!form) return;
  const input = document.querySelector<HTMLInputElement>('#voice-api-key');
  if (!input) return;
  const change = async (remove: boolean) => {
    if (pendingActions.has('voice-key')) return;
    if (currentState().call || pc || callStarting) {
      toast(t('voiceKeyCallActive'));
      return;
    }
    if (!remove && !input.reportValidity()) return;
    pendingActions.add('voice-key');
    render();
    try {
      if (remove) await api('/voice-key', { method: 'DELETE' });
      else await post('/voice-key', { key: input.value.trim() });
      input.value = '';
      const currentInput = document.querySelector<HTMLInputElement>('#voice-api-key');
      if (currentInput) currentInput.value = '';
      voiceLoadedFor = '';
      voiceChoices = [];
      apiVoiceChoices = [];
      voiceError = '';
      await api('/state')
        .then((fresh) => (state = fresh))
        .catch(() => {});
      toast(t(remove ? 'voiceKeyRemoved' : 'voiceKeySaved'));
      loadVoices();
    } catch (cause) {
      const error = requestError(cause);
      toast(errorText(error));
    } finally {
      pendingActions.delete('voice-key');
      render();
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    return change(false);
  };
  const remove = document.querySelector<HTMLElement>('#voice-key-remove');
  if (remove) remove.onclick = () => change(true);
}
function bindProvision() {
  const form = document.querySelector<HTMLFormElement>('#provision-form');
  if (!form) return;
  const options = document.querySelector<HTMLDetailsElement>('#provision-options');
  if (options) options.ontoggle = () => (provisionExpanded = options.open);
  const read = () => ({
    provider: formSelect(form, 'provider').value,
    cpu: Number(formInput(form, 'cpu').value),
    memoryGB: Number(formInput(form, 'memoryGB').value),
    diskGB: Number(formInput(form, 'diskGB').value),
    adminSudo: formInput(form, 'adminSudo').checked,
  });
  form.oninput = () => {
    provisionDraft = read();
  };
  formSelect(form, 'provider').onchange = () => {
    provisionDraft = read();
    render();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (
      pendingActions.has('provision') ||
      currentState().provisioning?.running ||
      currentState().settings.vm.host ||
      currentState().provisioning?.connection
    )
      return;
    pendingActions.add('provision');
    provisionDraft = read();
    render();
    try {
      currentState().provisioning = await post('/provision', provisionDraft);
    } catch (cause) {
      const error = requestError(cause);
      toast(errorText(error));
    } finally {
      pendingActions.delete('provision');
      render();
    }
  };
}
const boundComputerInputs = new WeakSet<HTMLElement>();
function bindComputerInput() {
  const target = document.querySelector<HTMLElement>('#screen-target'),
    ime = document.querySelector<HTMLTextAreaElement>('#vm-ime');
  if (!target || !ime) return;
  if (!computerInputReady() && document.activeElement === ime) ime.blur();
  if (boundComputerInputs.has(target)) return;
  boundComputerInputs.add(target);
  const point = (e: Pick<MouseEvent, 'clientX' | 'clientY'>) => {
    const img = document.querySelector<HTMLImageElement>('#screen');
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (
      !img.naturalWidth ||
      !rect.width ||
      screenError ||
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    )
      return null;
    return {
      x: Math.max(
        0,
        Math.min(
          img.naturalWidth - 1,
          Math.round(((e.clientX - rect.left) * img.naturalWidth) / rect.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          img.naturalHeight - 1,
          Math.round(((e.clientY - rect.top) * img.naturalHeight) / rect.height),
        ),
      ),
    };
  };
  target.onpointerdown = (e) => {
    if (!computerInputReady()) return;
    if (e.target === ime || ![0, 1, 2].includes(e.button)) return;
    const start = point(e);
    if (!start) return;
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    const drag = { ...start, button: e.button, clientX: e.clientX, clientY: e.clientY };
    target.onpointerup = (up) => {
      target.onpointerup = null;
      if (!computerInputReady()) return;
      const end = point(up);
      if (end) {
        if (Math.hypot(up.clientX - drag.clientX, up.clientY - drag.clientY) > 4)
          vmInput({
            type: 'drag',
            startX: drag.x,
            startY: drag.y,
            endX: end.x,
            endY: end.y,
            button: drag.button,
          });
        else vmInput({ type: 'click', ...end, button: drag.button });
      }
      ime.focus({ preventScroll: true });
    };
  };
  target.onpointercancel = () => (target.onpointerup = null);
  target.oncontextmenu = (e) => {
    if (computerInputReady()) e.preventDefault();
  };
  target.onwheel = (e) => {
    if (!computerInputReady()) return;
    e.preventDefault();
    if (e.deltaY) vmInput({ type: 'scroll', delta: Math.sign(e.deltaY) * 3 });
  };
  const sendText = () => {
    const text = ime.value;
    ime.value = '';
    if (!computerInputReady()) return;
    if (text) vmInput({ type: 'text', text });
  };
  ime.oninput = (e) => {
    if (!e.isComposing) sendText();
  };
  ime.addEventListener('compositionend', sendText);
  ime.onkeydown = (e) => {
    if (!computerInputReady()) return;
    if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return;
    const keys: Readonly<Partial<Record<string, string>>> = {
      Enter: 'Return',
      Backspace: 'BackSpace',
      Tab: 'Tab',
      Escape: 'Escape',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Delete: 'Delete',
      Home: 'Home',
      End: 'End',
      PageUp: 'Prior',
      PageDown: 'Next',
    };
    if (
      keys[e.key] ||
      ((e.ctrlKey || e.altKey) && e.key.length === 1 && e.key.toLowerCase() !== 'v')
    ) {
      e.preventDefault();
      vmInput({
        type: 'key',
        key: [
          e.ctrlKey ? 'ctrl' : null,
          e.altKey ? 'alt' : null,
          e.shiftKey ? 'shift' : null,
          keys[e.key] || e.key,
        ]
          .filter(Boolean)
          .join('+'),
      });
    }
  };
  target.onkeydown = (e) => {
    if (computerInputReady() && e.target === target && e.key === 'Enter') {
      e.preventDefault();
      ime.focus();
    }
  };
}
async function openExternal(url: string) {
  const parsed = new URL(url);
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw Error(t('unsupportedLink'));
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(parsed.href);
}
const pendingActions = new Set<string>();
async function action(a: string) {
  if (updateInstalling) return;
  if (a.startsWith('onboarding-') && (await firstRun.handle(a))) return;
  if (['chat', 'settings', 'computer-settings', 'memory', 'schedules', 'skills'].includes(a)) {
    const next = a === 'computer-settings' ? 'settings' : a;
    managedSettings.onClose(modal);
    chatHistory.onClose();
    chatCollections.onClose();
    if (next !== 'settings') {
      const secret = document.querySelector<HTMLInputElement>('#telegram-token');
      if (secret) secret.value = '';
      clearTelegramPairing();
    }
    if (next !== 'chat' && (dictating || speakingId)) await stopSpeech();
    attachmentMenu = false;
    if (next !== 'settings') {
      const secret = document.querySelector<HTMLInputElement>('#voice-api-key');
      if (secret) secret.value = '';
    }
    modal = null;
    emojiFor = null;
    if (next === 'chat') {
      chatMode = 'text';
      if (pc) callMini = true;
    }
    page = next;
    if (a === 'computer-settings') settingsNavigation.select('computer', '.vm-settings');
    else render();
    if (next === 'skills') await managedSettings.loadSkills();
    return;
  }
  if (a === 'clear-steer') {
    steerDraft = '';
    steerExpectedTurn = null;
    render();
    return;
  }
  if (a === 'details') {
    chatCollections.toggleMenu();
    return;
  }
  if (a === 'progress') {
    if (progressPanel.visible) progressPanel.close();
    else openProgress();
    return;
  }
  if (a === 'use-existing') {
    await useExistingComputer();
    return;
  }
  if (a === 'import-vm-profile') {
    if (selectedVMProfile) await importVMProfile({ id: selectedVMProfile });
    return;
  }
  if (a === 'setup') {
    openModal({ type: 'setup' });
    await loadVMProviders();
    return;
  }
  if (a === 'close-modal') {
    closeModal();
    return;
  }
  if (a === 'setup-done') {
    modal = null;
    page = 'chat';
    chatMode = 'text';
    render();
    return;
  }
  if (a === 'voice-mode') {
    page = 'chat';
    if (pc) {
      callMini = !callMini;
      chatMode = callMini ? 'text' : 'voice';
    } else chatMode = chatMode === 'voice' ? 'text' : 'voice';
    render();
    return;
  }
  if (a === 'text-mode') {
    chatMode = 'text';
    if (pc) callMini = true;
    render();
    return;
  }
  if (a === 'voice-settings') {
    page = 'settings';
    voiceApiExpanded = false;
    settingsNavigation.select('voice', '.voice-settings');
    return;
  }
  if (a === 'screen-refresh') {
    await screenLoad?.();
    return;
  }
  if (a === 'computer') {
    const fromChat = page === 'chat';
    showComputer = fromChat ? !showComputer : true;
    if (!fromChat) {
      chatMode = 'text';
      if (pc) callMini = true;
    }
    page = 'chat';
    modal = null;
    localStorage.setItem('computer', String(showComputer));
    render();
    return;
  }
  if (a === 'hide-computer') {
    showComputer = false;
    localStorage.setItem('computer', 'false');
    render();
    return;
  }
  if (a === 'attach-menu') {
    attachmentMenu = !attachmentMenu;
    render();
    return;
  }
  if (a === 'attach') {
    attachmentMenu = false;
    if (currentState().call?.provider === 'subscription') throw Error(t('callAttachment'));
    render();
    document.querySelector<HTMLInputElement>('#file-input')?.click();
    return;
  }
  if (a === 'cancel-record') {
    cancelRecording();
    return;
  }
  if (a === 'record') {
    attachmentMenu = false;
    await toggleRecord();
    return;
  }
  if (a === 'pause-record') {
    pauseRecording();
    return;
  }
  if (a === 'send-voice') {
    await sendVoice();
    return;
  }
  if (a === 'dictate') {
    await toggleDictation();
    return;
  }
  if (a === 'speech-stop') {
    await stopSpeech();
    return;
  }
  if (a === 'cancel-reply') {
    replyTo = null;
    render();
    return;
  }
  if (a === 'call-size') {
    callMini = !callMini;
    chatMode = callMini ? 'text' : 'voice';
    render();
    return;
  }
  if (a === 'mute') {
    callMuted = !callMuted;
    stream?.getAudioTracks().forEach((track) => (track.enabled = !callMuted));
    render();
    return;
  }
  if (a === 'takeover' && callBlocksControl()) throw Error(t('callControlBusy'));
  if (a === 'takeover' && !humanControl() && !computerExecutorReady())
    throw Error(t(computerReachable() ? 'agentOfflineControl' : 'computerEmpty'));
  if (pendingActions.has(a)) return;
  pendingActions.add(a);
  try {
    if (a === 'connect') {
      if (vmDraft && document.querySelector<HTMLFormElement>('#vm-form') && !(await saveVM()))
        return;
      render();
      await connectVM();
    }
    if (['service-pause', 'service-resume', 'service-install'].includes(a)) {
      if (pendingActions.has('service-update')) return;
      pendingActions.add('service-update');
      render();
      try {
        await post('/service-update', { action: a.slice(8) });
        state = await api('/state');
      } finally {
        pendingActions.delete('service-update');
        render();
      }
    }
    if (a === 'login') {
      loginDetails = await post('/login');
      render();
      if (window.__TAURI_INTERNALS__) await openExternal(loginDetails.verificationUrl);
    }
    if (a === 'logout') {
      await post('/logout');
      loginDetails = null;
      render();
    }
    if (a === 'stop') {
      await post('/tasks/pause');
      state = await api('/state');
    }
    if (a === 'takeover') {
      render();
      await post('/takeover', {
        enabled: !humanControl(),
        sessionId: currentState().computer?.sessionId,
      });
      state = await api('/state');
    }
    if (a === 'call' || a === 'call-api')
      await startCall(a === 'call-api' ? 'api' : 'subscription');
    if (a === 'hangup') await endCall();
    if (a === 'telegram-toggle')
      await updateTelegram('config', { enabled: !currentTelegram().enabled });
    if (a === 'telegram-pair') await updateTelegram('pair');
    if (a === 'telegram-unpair') await updateTelegram('disconnect', { clearToken: false });
    if (a === 'telegram-remove') await updateTelegram('disconnect', { clearToken: true });
    if (a === 'check-send') await checkUnconfirmedMessage();
    if (a === 'confirm-resend')
      await (messageSubmissions.unknown?.kind === 'voice' ? sendVoice(true) : send(true));
  } finally {
    pendingActions.delete(a);
    if (a === 'takeover' || a === 'connect') render();
  }
}
function clearSentDraft(
  raw: string | null | undefined,
  items: readonly Attachment[] = [],
  reply: string | null | undefined,
) {
  const current = document.querySelector<HTMLTextAreaElement>('#composer'),
    unchanged = (current?.value ?? composerDraft) === raw;
  if (unchanged) {
    composerDraft = '';
    if (current) current.value = '';
  }
  attachments = attachments.filter((item) => !items.some((sent) => sent.id === item.id));
  if (replyTo === reply) replyTo = null;
  return unchanged && !attachments.length && replyTo === null;
}
async function checkUnconfirmedMessage() {
  const uncertain = messageSubmissions.unknown;
  if (!uncertain) return;
  state = await api('/state');
  const found = messageSubmissions.find(currentState().messages);
  if (found) {
    messageSubmissions.acknowledged(uncertain.clientMessageId);
    if (uncertain.kind === 'voice') {
      if (recordDraft?.attempt?.clientMessageId === uncertain.clientMessageId)
        cancelRecording(true);
      if (
        !(document.querySelector<HTMLTextAreaElement>('#composer')?.value ?? composerDraft) &&
        !attachments.length &&
        !replyTo
      )
        taskReplies.acknowledged(uncertain.workReply);
    } else if (clearSentDraft(uncertain.raw, uncertain.items, uncertain.reply))
      taskReplies.acknowledged(uncertain.workReply);
    toast(t('sendFound'));
  } else toast(t('sendStillUnknown'));
  openProgress();
}
async function send(confirmResend = false) {
  if (updateInstalling) return;
  const input = document.querySelector<HTMLTextAreaElement>('#composer');
  if (!input || sending || uploading) return;
  if (recording || recordStarting || recordDraft) {
    toast(t('finishRecording'));
    return;
  }
  const raw = input.value,
    text = raw.trim(),
    items = [...attachments],
    reply = replyTo;
  if (!text && !items.length) return;
  if (messageSubmissions.unknown && !confirmResend) {
    toast(t('sendUnknownHint'));
    return;
  }
  if (!eventConnected) throw Error(t('connectionLost'));
  if (callStops.pending) throw Error(t('callNeedsStop'));
  const workReply = taskReplies.prepare(),
    nativeCall =
      !workReply && currentState().call?.provider === 'subscription' ? currentState().call : null;
  if (nativeCall && items.length) throw Error(t('callAttachment'));
  const route = nativeCall ? '/realtime/message' : '/messages',
    payload = nativeCall
      ? { callId: nativeCall.id || nativeCall.callId, text, ...(reply ? { replyTo: reply } : {}) }
      : {
          text,
          attachments: items.map((item) => item.id),
          replyTo: reply,
          ...(workReply ? { workReply } : {}),
        };
  const attempt = messageSubmissions.prepare(route, payload, { confirmResend });
  attempt.raw = raw;
  attempt.items = items;
  attempt.reply = reply;
  attempt.workReply = workReply;
  sending = true;
  taskReplies.setPending(true);
  render();
  try {
    const result = await post(route, { ...payload, clientMessageId: attempt.clientMessageId });
    if (result.unknownOutcome || (result.message || result).submission === SubmissionStatus.Unknown)
      throw Object.assign(Error(t('sendUnknownHint')), { unknownOutcome: true });
    messageSubmissions.acknowledged(attempt.clientMessageId);
    if (clearSentDraft(raw, items, reply)) taskReplies.acknowledged(workReply);
  } catch (cause) {
    const error = requestError(cause);
    if (error.unknownOutcome) {
      messageSubmissions.unconfirmed(attempt);
      throw Error(t('sendUnknownHint'));
    }
    throw error;
  } finally {
    sending = false;
    taskReplies.setPending(false);
    render();
    document.querySelector<HTMLTextAreaElement>('#composer')?.focus({ preventScroll: true });
  }
}
async function upload(file: File) {
  if (updateInstalling) return;
  if (file.size > MAX_ATTACHMENT_BYTES) throw Error(t('fileLimit'));
  if (attachments.length + uploading >= 5) throw Error(t('attachmentLimit'));
  uploading++;
  render();
  try {
    const form = new FormData();
    form.append('file', file);
    const item = await api('/upload', { method: 'POST', body: form });
    attachments.push(item);
  } finally {
    uploading--;
    render();
  }
}
function screenVisible() {
  return (
    !unloading &&
    page === 'chat' &&
    chatMode === 'text' &&
    showComputer &&
    computerReachable() &&
    !document.hidden &&
    document.hasFocus()
  );
}
function decodeScreenFrame(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', abort);
      if (error) {
        image.src = '';
        reject(error);
      } else resolve();
    };
    const abort = () => finish(Error('Screen decode cancelled'));
    image.onload = () =>
      Promise.resolve()
        .then(() => {
          if (!settled) return image.decode?.();
        })
        .then(
          () =>
            finish(
              image.naturalWidth > 0 && image.naturalHeight > 0 ? null : Error('Invalid screen'),
            ),
          () => finish(Error('Invalid screen')),
        );
    image.onerror = () => finish(Error('Invalid screen'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    image.src = url;
  });
}
function restartScreen() {
  if (!screenVisible()) {
    if (screenTimer !== null) clearInterval(screenTimer);
    screenTimer = null;
    screenLoad = null;
    screenEpoch++;
    screenAbort?.abort();
    return;
  }
  if (screenTimer) return;
  const load = async () => {
    if (screenBusy || !screenVisible()) return;
    screenBusy = true;
    const epoch = screenEpoch,
      controller = new AbortController();
    screenAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    let candidate = '';
    try {
      const response = await fetch(base + apiPath('/screen'), {
        headers: { 'X-Dant-Token': token },
        signal: controller.signal,
      });
      if (!response.ok) throw Error('Screen unavailable');
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw Error('Invalid screen');
      if (epoch !== screenEpoch || !screenVisible()) return;
      candidate = URL.createObjectURL(blob);
      await decodeScreenFrame(candidate, controller.signal);
      if (epoch !== screenEpoch || !screenVisible()) return;
      const img = document.querySelector<HTMLImageElement>('#screen');
      if (img) {
        const previous = screenURL;
        screenURL = candidate;
        candidate = '';
        screenFailures = 0;
        const hadStatus = !!screenError || !previous;
        screenError = '';
        img.onload = null;
        img.onerror = null;
        img.src = screenURL;
        if (previous) URL.revokeObjectURL(previous);
        if (hadStatus) render();
      }
    } catch {
      if (epoch === screenEpoch && screenVisible()) {
        screenFailures++;
        if (screenFailures >= 2 && !screenError) {
          screenError = true;
          render();
        }
      }
    } finally {
      if (candidate) URL.revokeObjectURL(candidate);
      clearTimeout(timeout);
      if (screenAbort === controller) screenAbort = null;
      screenBusy = false;
    }
  };
  screenLoad = load;
  load();
  screenTimer = setInterval(load, 1200);
}
async function loadVoices() {
  if (currentState().worker.status !== ConnectionStatus.Online) {
    voiceLoadedFor = '';
    voiceChoices = [];
    apiVoiceChoices = [];
    return;
  }
  const connection = [
    currentState().settings.vm.host,
    currentState().worker.account?.email || '',
    currentState().worker.realtime?.provider || '',
    voiceKeyConfigured(),
    currentState().worker.realtime?.subscription?.available,
  ].join('|');
  if (voiceLoadedFor === connection) return;
  voiceLoadedFor = connection;
  voiceError = '';
  try {
    const result = await api('/voices'),
      supported = result.voices || result,
      catalogue = Array.isArray(supported) ? null : supported,
      list =
        result.nativeV3 ||
        catalogue?.v3 ||
        (Array.isArray(supported)
          ? supported
          : [...(catalogue?.v1 || []), ...(catalogue?.v2 || [])]),
      apiList = result.apiV2 || result.api?.voices || catalogue?.v2 || [];
    const normalize = (values: readonly string[]): string[] =>
      [...new Set(values)].filter((value) => value.length > 0 && value.length <= 80);
    voiceChoices = normalize(list);
    apiVoiceChoices = normalize(apiList);
    if (!voiceChoices.length) voiceError = 'voiceUnavailable';
  } catch {
    voiceChoices = [];
    apiVoiceChoices = [];
    voiceError = 'voiceUnavailable';
  }
  if (page === 'settings') render();
}
async function startCall(provider: 'subscription' | 'api' = 'subscription') {
  if (updateInstalling) return;
  if (pc || callStarting) return;
  if (currentState().call || callStops.pending) throw Error(t('callNeedsStop'));
  if (currentState().worker.status !== ConnectionStatus.Online || !eventConnected)
    throw Error(t('setupHint'));
  if (provider === 'api' && apiVoiceUnavailable()) throw Error(t('voiceKeyRequired'));
  if (provider === 'subscription' && subscriptionVoiceUnavailable())
    throw Error(t('callUnavailable'));
  if (recording || recordStarting) throw Error(t('finishRecordingBeforeCall'));
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
    throw Error(t('mediaUnavailable'));
  const waitingGeneration = callGeneration;
  if (dictating || speakingId) await stopSpeech();
  if (updateInstalling || unloading || waitingGeneration !== callGeneration || pc || callStarting)
    return;
  if (recording || recordStarting || recordDraft) throw Error(t('finishRecordingBeforeCall'));
  if (currentState().call || callStops.pending) throw Error(t('callNeedsStop'));
  if (currentState().worker.status !== ConnectionStatus.Online || !eventConnected)
    throw Error(t('setupHint'));
  callDuration.reset();
  const generation = ++callGeneration;
  callStarting = true;
  callConnected = false;
  callId = null;
  callProvider = provider;
  page = 'chat';
  chatMode = 'voice';
  callMini = false;
  render();

  try {
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    if (generation !== callGeneration) {
      acquired.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = acquired;
    const peer = new RTCPeerConnection();
    pc = peer;
    const player = new Audio();
    audio = player;
    player.autoplay = true;
    peer.ontrack = (e) => {
      if (pc !== peer) return;
      player.srcObject = e.streams[0] || new MediaStream([e.track]);
      player.play().catch(() => toast(t('allowPlayback')));
    };
    acquired.getTracks().forEach((track) => peer.addTrack(track, acquired));
    const dc = peer.createDataChannel('oai-events');
    callChannel = dc;
    let confirming = false;
    const confirmConnection = async () => {
      if (
        pc !== peer ||
        generation !== callGeneration ||
        confirming ||
        callConnected ||
        !callId ||
        peer.connectionState !== 'connected' ||
        dc.readyState !== 'open'
      )
        return;
      const id = callId;
      confirming = true;
      try {
        const confirmation = await post('/call/connected', { callId: id });
        if (pc !== peer || generation !== callGeneration || id !== callId) return;
        callConnected = true;
        const currentCall = currentState().call;
        callDuration.start(
          id,
          confirmation.connectedAt ||
            (currentCall?.id === id ? currentCall.connectedAt : null) ||
            Date.now(),
        );
        clearTimeout(callTimeout);
        render();
      } catch {
        if (pc === peer && generation === callGeneration) {
          toast(t('callFailed'));
          endCall().catch(() => {});
        }
      } finally {
        confirming = false;
      }
    };
    dc.onopen = () => {
      confirmConnection();
      render();
    };
    dc.onclose = () => {
      if (pc === peer && callConnected) {
        toast(t('callEnded'));
        endCall().catch(() => {});
      }
    };
    dc.onerror = () => {
      if (pc === peer) {
        toast(t('callFailed'));
        endCall().catch(() => {});
      }
    };
    dc.onmessage = (e) => {
      try {
        if (typeof e.data !== 'string') return;
        const event: unknown = JSON.parse(e.data);
        if (isRecord(event) && event.type === 'error')
          toast(errorText(event.error || t('callFailed')));
      } catch {}
    };
    peer.onconnectionstatechange = () => {
      if (pc !== peer) return;
      if (peer.connectionState === 'failed') {
        toast(t('callFailed'));
        endCall().catch(() => {});
      } else {
        confirmConnection();
        render();
      }
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (generation !== callGeneration) return;
    const result = await post('/call', { sdp: offer.sdp, provider });
    if (generation !== callGeneration) {
      if (result.callId) {
        callStops.add(result.callId);
        await flushCallStops();
      }
      return;
    }
    callId = result.callId || currentState().call?.callId || currentState().call?.id || null;
    callSubtitles.sync({ id: callId, provider }, callCaptionScope(state));
    const answer = result.sdp || result.transport?.sdp;
    if (answer && !peer.remoteDescription)
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    callStarting = false;
    callTimeout = setTimeout(() => {
      if (pc === peer && !callConnected) {
        toast(t('callFailed'));
        endCall().catch(() => {});
      }
    }, 30000);
    confirmConnection();
    render();
  } catch (cause) {
    const error = requestError(cause);
    if (generation === callGeneration) {
      const id = callId;
      cleanupCall();
      if (id) {
        callStops.add(id);
        flushCallStops();
      }
      render();
      throw error;
    }
  }
}
function cleanupCall() {
  callSubtitles.end();
  callDuration.stop(callId || state?.call?.id || callDuration.snapshot.callId);
  clearTimeout(callTimeout);
  callGeneration++;
  callStarting = false;
  callConnected = false;
  callId = null;
  const dc = callChannel;
  callChannel = null;
  if (dc) {
    dc.onopen = null;
    dc.onclose = null;
    dc.onerror = null;
    dc.onmessage = null;
  }
  const peer = pc;
  pc = null;
  if (peer) {
    peer.onconnectionstatechange = null;
    peer.ontrack = null;
    peer.close();
  }
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  audio?.pause();
  if (audio) audio.srcObject = null;
  audio = null;
  callMuted = false;
  callMini = false;
}
async function flushCallStops() {
  if (!eventConnected || unloading || !callStops.pending) return;
  const errors = await callStops.flush();
  if (!errors.length)
    try {
      state = await api('/state');
      callDuration.sync(currentState().call, currentState().messages);
    } catch {}
  if (state) render();
  if (errors.length) toast(t('callNeedsStop'));
}
async function endCall() {
  const id = callId || currentState().call?.id || currentState().call?.callId;
  cleanupCall();
  if (id) callStops.add(id);
  render();
  await flushCallStops();
}
function cancelRecording(force = false) {
  if (!force && (recordDraft?.busy || messageSubmissions.unknown?.kind === 'voice')) return;
  recordGeneration++;
  recordStarting = false;
  if (recordTimer !== null) clearInterval(recordTimer);
  recordTimer = null;
  const draft = recordDraft,
    recorder = recording;
  recordDraft = null;
  recording = null;
  document.querySelector<HTMLAudioElement>('.voice-message-recorder audio')?.pause?.();
  if (draft?.previewURL) URL.revokeObjectURL(draft.previewURL);
  if (recorder) {
    recorder.dantDiscard = true;
    if (recorder.state !== 'inactive') recorder.stop();
    recorder.stream?.getTracks().forEach((track) => track.stop());
  }
  draft?.resolveStop?.(null);
  if (!unloading) render();
}
function previewRecording(draft: RecordingDraft) {
  if (recordDraft !== draft || !draft.chunks.length) return;
  document.querySelector<HTMLAudioElement>('.voice-message-recorder audio')?.pause?.();
  const previous = draft.previewURL;
  draft.previewURL = URL.createObjectURL(new Blob(draft.chunks, { type: draft.mimeType }));
  if (previous) URL.revokeObjectURL(previous);
  if (!unloading) render();
}
function pauseRecording() {
  const draft = recordDraft,
    recorder = recording;
  if (!draft || draft.busy || !recorder || speechBlocked()) return;
  if (draft.status === RecordingDraftStatus.Recording) {
    recorder.pause();
    draft.elapsedMs += Date.now() - draft.startedAt;
    draft.status = RecordingDraftStatus.Paused;
    recorder.requestData();
  } else if (draft.status === RecordingDraftStatus.Paused) {
    document.querySelector<HTMLAudioElement>('.voice-message-recorder audio')?.pause?.();
    if (draft.previewURL) {
      URL.revokeObjectURL(draft.previewURL);
      draft.previewURL = '';
    }
    recorder.resume();
    draft.startedAt = Date.now();
    draft.status = RecordingDraftStatus.Recording;
  }
  render();
}
async function toggleRecord() {
  if (recording || recordStarting || recordDraft) return;
  if (speechBlocked()) throw Error(t('recordDuringCall'));
  if (dictating) throw Error(t('stopSpeech'));
  if (messageSubmissions.unknown) throw Error(t('sendUnknownHint'));
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
    throw Error(t('mediaUnavailable'));
  const mimeType = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ].find((type) => MediaRecorder.isTypeSupported?.(type));
  if (!mimeType) throw Error(t('recordUnsupported'));
  const generation = ++recordGeneration;
  recordStarting = true;
  let mic: MediaStream | undefined;
  render();
  try {
    if (speakingId) await stopSpeech();
    if (generation !== recordGeneration || unloading || speechBlocked() || recording) return;
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== recordGeneration || unloading || speechBlocked()) {
      mic.getTracks().forEach((track) => track.stop());
      return;
    }
    const acquiredMic = mic;
    const recorder: DraftRecorder = new MediaRecorder(acquiredMic, { mimeType });
    const draft: RecordingDraft = {
      generation,
      mimeType: recorder.mimeType || mimeType,
      chunks: [],
      bytes: 0,
      elapsedMs: 0,
      startedAt: Date.now(),
      status: RecordingDraftStatus.Recording,
      previewURL: '',
      file: null,
      uploaded: null,
      busy: false,
    };
    draft.stopped = new Promise<File | null>((resolve) => (draft.resolveStop = resolve));
    recording = recorder;
    recordDraft = draft;
    recorder.ondataavailable = (e) => {
      if (!e.data.size || recorder.dantDiscard || recordDraft !== draft) return;
      draft.bytes += e.data.size;
      if (draft.bytes > MAX_ATTACHMENT_BYTES) {
        cancelRecording(true);
        toast(t('fileLimit'));
        return;
      }
      draft.chunks.push(e.data);
      if (draft.status === RecordingDraftStatus.Paused) previewRecording(draft);
    };
    recorder.onstop = () => {
      acquiredMic.getTracks().forEach((track) => track.stop());
      if (recordDraft === draft) {
        if (recordTimer !== null) clearInterval(recordTimer);
        recordTimer = null;
      }
      if (
        recorder.dantDiscard ||
        unloading ||
        generation !== recordGeneration ||
        recordDraft !== draft
      ) {
        draft.resolveStop?.(null);
        return;
      }
      if (draft.status === RecordingDraftStatus.Recording)
        draft.elapsedMs += Date.now() - draft.startedAt;
      draft.status = RecordingDraftStatus.Ready;
      const extension = draft.mimeType.includes('ogg') ? 'ogg' : 'webm';
      if (draft.chunks.length)
        draft.file = new File(draft.chunks, `voice-${Date.now()}.${extension}`, {
          type: draft.mimeType,
        });
      previewRecording(draft);
      draft.resolveStop?.(draft.file);
      render();
    };
    recorder.onerror = () => {
      if (recordDraft !== draft) return;
      cancelRecording(true);
      toast(t('recordFailed'));
    };
    recorder.start(1000);
    recordTimer = setInterval(() => {
      if (recordDraft !== draft) return;
      if (speechBlocked()) {
        cancelRecording(true);
        return;
      }
      const time = document.querySelector<HTMLButtonElement>('[data-record-duration]');
      if (time) time.textContent = recordingTime();
    }, 250);
    render();
  } catch (cause) {
    const error = requestError(cause);
    mic?.getTracks().forEach((track) => track.stop());
    if (generation === recordGeneration) {
      recording = null;
      recordDraft = null;
    }
    throw error;
  } finally {
    if (generation === recordGeneration) {
      recordStarting = false;
      if (!unloading) render();
    }
  }
}
async function sendVoice(confirmResend = false) {
  if (updateInstalling) return;
  const draft = recordDraft;
  if (!draft || draft.busy || sending || uploading) return;
  if (messageSubmissions.unknown && !confirmResend) {
    toast(t('voiceUnknown'));
    return;
  }
  if (!eventConnected) throw Error(t('connectionLost'));
  if (speechBlocked()) throw Error(t('recordDuringCall'));
  const workReply = taskReplies.prepare(),
    generation = draft.generation;
  draft.busy = true;
  sending = true;
  taskReplies.setPending(true);
  render();
  try {
    if (!draft.file) {
      if (draft.status === RecordingDraftStatus.Recording)
        draft.elapsedMs += Date.now() - draft.startedAt;
      draft.status = RecordingDraftStatus.Finishing;
      if (recording && recording.state !== 'inactive') recording.stop();
      await draft.stopped;
    }
    if (recordDraft !== draft || generation !== recordGeneration || unloading) return;
    if (!draft.file?.size) throw Error(t('recordEmpty'));
    if (!draft.uploaded) {
      const form = new FormData();
      form.append('file', draft.file);
      draft.uploaded = await api('/upload', { method: 'POST', body: form });
    }
    if (recordDraft !== draft || generation !== recordGeneration || unloading) return;
    if (!eventConnected) throw Error(t('connectionLost'));
    if (speechBlocked()) throw Error(t('recordDuringCall'));
    taskReplies.prepare();
    const payload = {
        text: '',
        attachments: [draft.uploaded.id],
        replyTo: null,
        ...(workReply ? { workReply } : {}),
      },
      attempt = messageSubmissions.prepare('/messages', payload, { confirmResend });
    attempt.kind = 'voice';
    attempt.items = [draft.uploaded];
    attempt.raw = null;
    attempt.reply = null;
    attempt.workReply = workReply;
    draft.attempt = attempt;
    try {
      const result = await post('/messages', {
        ...payload,
        clientMessageId: attempt.clientMessageId,
      });
      if (
        result.unknownOutcome ||
        (result.message || result).submission === SubmissionStatus.Unknown
      )
        throw Object.assign(Error(t('sendUnknownHint')), { unknownOutcome: true });
      messageSubmissions.acknowledged(attempt.clientMessageId);
      if (recordDraft === draft) cancelRecording(true);
      if (
        !(document.querySelector<HTMLTextAreaElement>('#composer')?.value ?? composerDraft) &&
        !attachments.length &&
        !replyTo
      )
        taskReplies.acknowledged(workReply);
    } catch (cause) {
      const error = requestError(cause);
      if (error.unknownOutcome) {
        messageSubmissions.unconfirmed(attempt);
        throw Error(t('voiceUnknown'));
      }
      throw error;
    }
  } finally {
    draft.busy = false;
    sending = false;
    taskReplies.setPending(false);
    if (recordDraft === draft && draft.status === RecordingDraftStatus.Finishing)
      draft.status = RecordingDraftStatus.Ready;
    if (!unloading) render();
  }
}
async function requestNotifications() {
  if (window.__TAURI_INTERNALS__) {
    const mod = await import('@tauri-apps/plugin-notification');
    return (await mod.requestPermission()) === 'granted';
  }
  return 'Notification' in window && (await Notification.requestPermission()) === 'granted';
}
async function notify(message: string) {
  if (!currentState().settings.notifications || window.__TAURI_INTERNALS__) return;
  if ('Notification' in window && Notification.permission === 'granted')
    new Notification('dant', { body: message });
}
const readTimers = new Map<string, Timer>(),
  readTargets = new Map<string, HTMLElement>(),
  readPending = new Set<string>(),
  readBatch = new Set<string>(),
  readAttachmentSnapshots = new Map<string, string[]>();
let readObserver: IntersectionObserver | null = null;
let readRoot: HTMLElement | null = null;
let readFlush: Timer | null = null;
function canReadMessages() {
  return (
    !!state &&
    eventConnected &&
    page === 'chat' &&
    chatMode === 'text' &&
    readVisibility.visible &&
    !document.hidden &&
    document.hasFocus() &&
    !modal &&
    (!pc || callMini)
  );
}
function messageInViewport(element: Element | null | undefined) {
  if (!readRoot || !element?.isConnected) return false;
  const box = element.getBoundingClientRect(),
    viewport = readRoot.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0)
    return false;
  const height = Math.min(box.bottom, viewport.bottom) - Math.max(box.top, viewport.top),
    width = Math.min(box.right, viewport.right) - Math.max(box.left, viewport.left);
  return (
    height >= Math.min(box.height, viewport.height) * 0.5 &&
    width >= Math.min(box.width, viewport.width) * 0.5
  );
}
function observedAttachmentIds(message: ReadMessage | undefined) {
  return [
    ...new Set(
      (message?.attachments || [])
        .map((file) => file?.id)
        .filter(
          (id) =>
            typeof id === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
        ),
    ),
  ]
    .sort()
    .slice(0, 5);
}
function clearReadTimer(id: string) {
  clearTimeout(readTimers.get(id));
  readTimers.delete(id);
  readBatch.delete(id);
  readAttachmentSnapshots.delete(id);
}
function stopReadTracking() {
  for (const id of readTimers.keys()) clearReadTimer(id);
  readObserver?.disconnect();
  readObserver = null;
  readTargets.clear();
  readRoot = null;
  if (readFlush !== null) clearTimeout(readFlush);
  readFlush = null;
  readBatch.clear();
}
function refreshReadTimers() {
  if (!canReadMessages()) {
    stopReadTracking();
    return;
  }
  for (const [id, element] of readTargets) {
    const message = currentState().messages.find((item) => item.id === id);
    if (!unreadAssistant(message) || !messageInViewport(element)) {
      clearReadTimer(id);
      continue;
    }
    const snapshot = observedAttachmentIds(message);
    if (
      readAttachmentSnapshots.has(id) &&
      JSON.stringify(readAttachmentSnapshots.get(id)) !== JSON.stringify(snapshot)
    )
      clearReadTimer(id);
    if (readTimers.has(id) || readPending.has(id) || readBatch.has(id)) continue;
    readAttachmentSnapshots.set(id, snapshot);
    readTimers.set(
      id,
      setTimeout(() => {
        readTimers.delete(id);
        if (
          !canReadMessages() ||
          !messageInViewport(element) ||
          !unreadAssistant(currentState().messages.find((item) => item.id === id))
        )
          return;
        if (
          JSON.stringify(readAttachmentSnapshots.get(id)) !==
          JSON.stringify(
            observedAttachmentIds(currentState().messages.find((item) => item.id === id)),
          )
        ) {
          clearReadTimer(id);
          refreshReadTimers();
          return;
        }
        readBatch.add(id);
        if (readFlush === null) readFlush = setTimeout(flushReadReceipts, 0);
      }, 450),
    );
  }
}
function flushReadReceipts() {
  readFlush = null;
  const ids = [...readBatch].filter(
    (id) =>
      canReadMessages() &&
      messageInViewport(readTargets.get(id)) &&
      unreadAssistant(currentState().messages.find((item) => item.id === id)),
  );
  readBatch.clear();
  if (!ids.length) return;
  const attachmentSnapshots = Object.fromEntries(
    ids.map((id) => [id, [...(readAttachmentSnapshots.get(id) || [])]]),
  );
  ids.forEach((id) => {
    readPending.add(id);
    clearReadTimer(id);
  });
  post('/read', { ids, attachmentSnapshots })
    .then(() => {
      ids.forEach((id) => readPending.delete(id));
      updateRead();
    })
    .catch(() => {
      ids.forEach((id) => readPending.delete(id));
      setTimeout(updateRead, 1000);
    });
}
function updateRead() {
  if (!canReadMessages()) {
    stopReadTracking();
    return;
  }
  const root = document.querySelector<HTMLElement>('#messages');
  if (!root) {
    stopReadTracking();
    return;
  }
  if (readRoot !== root) {
    stopReadTracking();
    readRoot = root;
    if ('IntersectionObserver' in window) {
      readObserver = new IntersectionObserver(refreshReadTimers, {
        root,
        threshold: [0, 0.25, 0.5, 0.75, 1],
      });
    }
    root.onscroll = () => {
      refreshReadTimers();
      positionReactionMenus();
    };
  }
  const nodes = new Map<string, HTMLElement>(
    [...root.querySelectorAll<HTMLElement>('.message.assistant[data-id]')].map((element) => [
      requiredData(element, 'id'),
      element,
    ]),
  );
  for (const [id, element] of readTargets)
    if (
      !nodes.has(id) ||
      !unreadAssistant(currentState().messages.find((item) => item.id === id))
    ) {
      clearReadTimer(id);
      readObserver?.unobserve(element);
      readTargets.delete(id);
      readPending.delete(id);
    }
  for (const [id, element] of nodes)
    if (
      unreadAssistant(currentState().messages.find((item) => item.id === id)) &&
      !readTargets.has(id)
    ) {
      readTargets.set(id, element);
      readObserver?.observe(element);
    }
  refreshReadTimers();
}
async function handleEvent(event: TransportEvent) {
  if (event.type === 'state') {
    eventConnected = true;
    state = readAppState(event.data);
    void firstRun.observe();
    await restoreUpdateDraft();
    callDuration.sync(currentState().call, currentState().messages);
    callSubtitles.sync(currentState().call, callCaptionScope(state));
    callSubtitles.receiveSnapshot(currentState().callCaption);
    const telegram = currentState().telegram || currentState().worker.telegram;
    if (telegram) {
      telegramStatus = telegram;
      if (telegram.paired) clearTelegramPairing();
    }
    fallbackLanguage = language();
    localStorage.setItem('dant.language', fallbackLanguage);
    if (speechBlocked() && (dictating || speakingId)) stopSpeech().catch(() => {});
    if (currentState().worker.account) loginDetails = null;
    for (const message of currentState().messages.filter(
      (item) => item.role === 'assistant' && item.status === TaskStatus.Completed,
    )) {
      if (
        initialized &&
        !lastAssistant.has(message.id) &&
        (document.hidden || !document.hasFocus() || page !== 'chat')
      )
        notify(message.text.slice(0, 160) || t('completed')).catch(() => {});
      lastAssistant.add(message.id);
    }
    initialized = true;
    if (!currentState().call && pc && !callStarting) cleanupCall();
    render();
    loadVoices();
  }
  if (event.type === 'notice' && isRecord(event.data) && typeof event.data.message === 'string')
    toast(errorText(event.data.message, 'serviceNotice'));
  if (event.type === 'realtime') {
    const eventData = event.data;
    if (!isRecord(eventData) || typeof eventData.method !== 'string' || !isRecord(eventData.params))
      return;
    const params = eventData.params,
      eventCallId = params.callId;
    if (eventCallId && eventCallId !== callId) return;
    if (eventData.method === 'dant/call/subtitle') callSubtitles.receive(eventData);
    if (
      eventData.method === 'thread/realtime/sdp' &&
      typeof params.sdp === 'string' &&
      pc?.signalingState === 'have-local-offer'
    )
      await pc.setRemoteDescription({ type: 'answer', sdp: params.sdp });
    if (eventData.method === 'thread/realtime/error') {
      toast(errorText(typeof params.message === 'string' ? params.message : t('callFailed')));
      cleanupCall();
      render();
    }
    if (eventData.method === 'thread/realtime/closed') {
      cleanupCall();
      render();
    }
  }
}
function connectEvents() {
  transport.startEvents({
    onEvent: handleEvent,
    onConnection: (connected) => {
      if (unloading || eventConnected === connected) return;
      const hadConnection = eventConnected;
      eventConnected = connected;
      if (!connected) {
        if (callId) callStops.add(callId);
        cleanupCall();
        stopReadTracking();
      } else if (callStops.pending) flushCallStops();
      if (state) render();
      if (!connected && hadConnection) toast(t('connectionLost'));
    },
  });
}
document.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (!target || !('closest' in target) || typeof target.closest !== 'function') return;
  if (fontMenuOpen && !target.closest('.font-picker')) {
    fontMenuOpen = false;
    render();
  }
  if (attachmentMenu && !target.closest('.attachment-control')) {
    attachmentMenu = false;
    render();
  }
  if (emojiFor && !target.closest('.reaction-menu,[data-picker]')) {
    emojiFor = null;
    render();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.isComposing) {
    if (fontMenuOpen) {
      fontMenuOpen = false;
      render();
      document
        .querySelector<HTMLElement>('#appearance-font-picker>summary')
        ?.focus({ preventScroll: true });
      return;
    }
    if (attachmentMenu) {
      attachmentMenu = false;
      render();
      return;
    }
    if (dictating || speakingId) {
      stopSpeech().catch(() => {});
      return;
    }
    if (emojiFor) {
      emojiFor = null;
      render();
      return;
    }
    if (modal) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (chatMode === 'voice' && !pc && !callStarting) {
      chatMode = 'text';
      render();
      return;
    }
  }
  if (event.key === 'Tab' && modal) {
    const dialog = document.querySelector<HTMLElement>('.dialog');
    if (!dialog) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
      ),
    ].filter((element) => element.getClientRects().length);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0],
      last = focusable.at(-1),
      active = document.activeElement;
    if (!first || !last) return;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || active === dialog || !dialog.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  }
});
document.addEventListener('visibilitychange', () => {
  updateRead();
  restartScreen();
});
window.addEventListener('focus', () => {
  updateRead();
  restartScreen();
});
window.addEventListener('blur', () => {
  stopReadTracking();
  restartScreen();
});
window.addEventListener('resize', () => {
  updateRead();
  positionReactionMenus();
});
window.addEventListener('beforeunload', () => {
  unloading = true;
  chatScroll.dispose();
  workspaceLayout.dispose();
  messageWindow.dispose();
  chatCollections.dispose();
  memorySettings.dispose();
  vmBackups.dispose();
  firstRun.dispose();
  recoverySettings.hide();
  settingsNavigation.sync(false);
  appUpdates.dispose();
  nativeTray.dispose();
  textEditor.dispose();
  clearInterval(presenceTimer);
  managedSettings.clearSecret();
  clearTelegramPairing();
  appearance.dispose();
  speechGeneration++;
  speech.stop().catch(() => {});
  stopReadTracking();
  if (screenTimer !== null) clearInterval(screenTimer);
  screenAbort?.abort();
  const hadCall = !!pc || callStarting || state?.call,
    id = callId;
  cleanupCall();
  cancelRecording(true);
  if (hadCall && id)
    transport
      .json(apiPath('/call/stop'), { method: 'POST', body: { callId: id }, keepalive: true })
      .catch(() => {});
  transport.close();
  if (screenURL) URL.revokeObjectURL(screenURL);
});
async function boot() {
  document.documentElement.lang = languageInfo(language()).locale;
  document.documentElement.dir = languageInfo(language()).direction;
  try {
    await loadLanguage(language());
    const session = await transport.json(NATIVE_PROTOCOL.paths.session);
    if (!isRecord(session) || typeof session.token !== 'string') throw Error('Invalid session');
    transport.setToken(session.token);
    state = await api('/state');
    await loadLanguage(language());
    await restoreUpdateDraft();
    callDuration.sync(currentState().call, currentState().messages);
    for (const message of currentState().messages.filter(
      (m) => m.role === 'assistant' && m.status === TaskStatus.Completed,
    ))
      lastAssistant.add(message.id);
    recoverySettings.hide();
    void firstRun.observe();
    render();
    startPresenceTicker();
    connectEvents();
  } catch (cause) {
    recoverySettings.show({
      stateUnavailable: cause instanceof Error && cause.message === 'Invalid application state',
    });
  }
}
boot();

/** Types for isolated entrypoint fixtures; exporting types has no browser side effects. */
export type MainFunctions = {
  currentState: typeof currentState;
  language: typeof language;
  t: typeof t;
  errorText: typeof errorText;
  changeLanguage: typeof changeLanguage;
  vmProviderLabel: typeof vmProviderLabel;
  reactionName: typeof reactionName;
  vmConfiguredProvider: typeof vmConfiguredProvider;
  vmSystemDescription: typeof vmSystemDescription;
  vmProviderStatus: typeof vmProviderStatus;
  loadVMProviders: typeof loadVMProviders;
  setupStageText: typeof setupStageText;
  subscriptionVoiceUnavailable: typeof subscriptionVoiceUnavailable;
  apiVoiceUnavailable: typeof apiVoiceUnavailable;
  humanControl: typeof humanControl;
  computerReachable: typeof computerReachable;
  computerExecutorReady: typeof computerExecutorReady;
  callControlBusy: typeof callControlBusy;
  computerInputReady: typeof computerInputReady;
  callBlocksControl: typeof callBlocksControl;
  unknownTask: typeof unknownTask;
  voiceKeyConfigured: typeof voiceKeyConfigured;
  ico: typeof ico;
  button: typeof button;
  eyes: typeof eyes;
  decodeApiResult: typeof decodeApiResult;
  api: typeof api;
  post: typeof post;
  updateInstallState: typeof updateInstallState;
  saveUpdateDraft: typeof saveUpdateDraft;
  restoreUpdateDraft: typeof restoreUpdateDraft;
  toast: typeof toast;
  md: typeof md;
  render: typeof render;
  openProgress: typeof openProgress;
  renderRail: typeof renderRail;
  renderHeader: typeof renderHeader;
  currentPresence: typeof currentPresence;
  chatSearchLabel: typeof chatSearchLabel;
  unreadAssistant: typeof unreadAssistant;
  unreadMessages: typeof unreadMessages;
  unreadLabel: typeof unreadLabel;
  renderAssistantReadState: typeof renderAssistantReadState;
  renderUnreadControl: typeof renderUnreadControl;
  revealMessage: typeof revealMessage;
  updatePresence: typeof updatePresence;
  startPresenceTicker: typeof startPresenceTicker;
  recordingSeconds: typeof recordingSeconds;
  recordingTime: typeof recordingTime;
  renderVoiceRecorder: typeof renderVoiceRecorder;
  renderChat: typeof renderChat;
  renderDraftAttachment: typeof renderDraftAttachment;
  renderAttachmentOptions: typeof renderAttachmentOptions;
  speechBlocked: typeof speechBlocked;
  stopSpeech: typeof stopSpeech;
  toggleDictation: typeof toggleDictation;
  spokenText: typeof spokenText;
  readAloud: typeof readAloud;
  fileURL: typeof fileURL;
  formatTime: typeof formatTime;
  renderAttachment: typeof renderAttachment;
  renderAttachments: typeof renderAttachments;
  messageDate: typeof messageDate;
  renderMessages: typeof renderMessages;
  positionReactionMenus: typeof positionReactionMenus;
  renderComputer: typeof renderComputer;
  renderSettings: typeof renderSettings;
  loadSettingsCategory: typeof loadSettingsCategory;
  appearanceColor: typeof appearanceColor;
  renderAppearance: typeof renderAppearance;
  changeAppearance: typeof changeAppearance;
  loadFonts: typeof loadFonts;
  appearanceExportData: typeof appearanceExportData;
  importAppearanceData: typeof importAppearanceData;
  exportAppearance: typeof exportAppearance;
  bindAppearance: typeof bindAppearance;
  bindVMSettings: typeof bindVMSettings;
  hasVMConnection: typeof hasVMConnection;
  renderVMSettings: typeof renderVMSettings;
  renderVMProfiles: typeof renderVMProfiles;
  useExistingComputer: typeof useExistingComputer;
  connectVM: typeof connectVM;
  saveAndConnectVM: typeof saveAndConnectVM;
  importVMProfile: typeof importVMProfile;
  currentTelegram: typeof currentTelegram;
  telegramOnline: typeof telegramOnline;
  telegramForwardingCopy: typeof telegramForwardingCopy;
  telegramForwarding: typeof telegramForwarding;
  telegramForwardingOnline: typeof telegramForwardingOnline;
  telegramSettingsScope: typeof telegramSettingsScope;
  renderTelegramForwardingChange: typeof renderTelegramForwardingChange;
  renderTelegramForwarding: typeof renderTelegramForwarding;
  renderTelegramSettings: typeof renderTelegramSettings;
  renderTelegramConnectionSettings: typeof renderTelegramConnectionSettings;
  telegramBotURL: typeof telegramBotURL;
  setTelegramStatus: typeof setTelegramStatus;
  clearTelegramPairing: typeof clearTelegramPairing;
  loadTelegram: typeof loadTelegram;
  updateTelegram: typeof updateTelegram;
  bindTelegram: typeof bindTelegram;
  renderVoiceSettings: typeof renderVoiceSettings;
  renderProvisionCard: typeof renderProvisionCard;
  renderMemory: typeof renderMemory;
  renderSchedules: typeof renderSchedules;
  renderCallReady: typeof renderCallReady;
  updateCallDuration: typeof updateCallDuration;
  renderCall: typeof renderCall;
  publishCallOverlay: typeof publishCallOverlay;
  handleNativeCallAction: typeof handleNativeCallAction;
  renderUnconfirmedMessage: typeof renderUnconfirmedMessage;
  conversationFiles: typeof conversationFiles;
  outputLinkScope: typeof outputLinkScope;
  resolveMessageOutputLink: typeof resolveMessageOutputLink;
  renderProgress: typeof renderProgress;
  renderModal: typeof renderModal;
  openModal: typeof openModal;
  closeModal: typeof closeModal;
  resizeComposer: typeof resizeComposer;
  renderLoginDetails: typeof renderLoginDetails;
  formVM: typeof formVM;
  saveVM: typeof saveVM;
  vmInput: typeof vmInput;
  bind: typeof bind;
  taskRequest: typeof taskRequest;
  resumeTask: typeof resumeTask;
  bindSteer: typeof bindSteer;
  bindVoiceKey: typeof bindVoiceKey;
  bindProvision: typeof bindProvision;
  bindComputerInput: typeof bindComputerInput;
  openExternal: typeof openExternal;
  action: typeof action;
  clearSentDraft: typeof clearSentDraft;
  checkUnconfirmedMessage: typeof checkUnconfirmedMessage;
  send: typeof send;
  upload: typeof upload;
  screenVisible: typeof screenVisible;
  decodeScreenFrame: typeof decodeScreenFrame;
  restartScreen: typeof restartScreen;
  loadVoices: typeof loadVoices;
  startCall: typeof startCall;
  cleanupCall: typeof cleanupCall;
  flushCallStops: typeof flushCallStops;
  endCall: typeof endCall;
  cancelRecording: typeof cancelRecording;
  previewRecording: typeof previewRecording;
  pauseRecording: typeof pauseRecording;
  toggleRecord: typeof toggleRecord;
  sendVoice: typeof sendVoice;
  requestNotifications: typeof requestNotifications;
  notify: typeof notify;
  canReadMessages: typeof canReadMessages;
  messageInViewport: typeof messageInViewport;
  observedAttachmentIds: typeof observedAttachmentIds;
  clearReadTimer: typeof clearReadTimer;
  stopReadTracking: typeof stopReadTracking;
  refreshReadTimers: typeof refreshReadTimers;
  flushReadReceipts: typeof flushReadReceipts;
  updateRead: typeof updateRead;
  handleEvent: typeof handleEvent;
  connectEvents: typeof connectEvents;
  boot: typeof boot;
};
export type MainBindings = {
  callStops: typeof callStops;
  createElement: typeof createElement;
  renderWorkSummary: typeof renderWorkSummary;
  renderUsageSettings: typeof renderUsageSettings;
  floatingCall: Pick<typeof floatingCall, 'sync'>;
  nativeCallOverlay: Pick<typeof nativeCallOverlay, 'update'>;
  scheduledTasks: typeof scheduledTasks;
  managedSettings: typeof managedSettings;
  appUpdates: typeof appUpdates;
  document: Document;
  progressActions: typeof progressActions;
  progressPanel: typeof progressPanel;
  workspaceLayout: Pick<typeof workspaceLayout, 'bind' | 'dispose'>;
  workDisclosures: typeof workDisclosures;
  chatHistory: typeof chatHistory;
  chatCollections: typeof chatCollections;
  updateInstalling: typeof updateInstalling;
  callDuration: typeof callDuration;
  callSubtitles: typeof callSubtitles;
  callCaptionPreferences: typeof callCaptionPreferences;
  chatScroll: Pick<typeof chatScroll, 'capture' | 'restore' | 'dispose' | 'navigate'>;
  appearance: typeof appearance;
  memorySettings: Pick<typeof memorySettings, 'setVisible' | 'render' | 'bind' | 'dispose'>;
  vmBackups: typeof vmBackups;
  messageWindow: typeof messageWindow;
  firstRun: typeof firstRun;
  recoverySettings: typeof recoverySettings;
  settingsNavigation: typeof settingsNavigation;
  usageActivity: typeof usageActivity;
  taskReplies: typeof taskReplies;
};
