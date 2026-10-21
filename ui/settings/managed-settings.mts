import { escapeHtml as escape } from '../shared/html.mts';
import {
  isRecord,
  isSafeInteger,
  isFiniteNumber,
  requestError,
  attachmentSnapshot,
} from '../shared/contracts.mts';
import type { SkillAssetMetadata } from './skill-types.ts';
import type {
  Attachment,
  ApiOptions,
  ApiRequest,
  UiState,
  UiModal,
  CredentialItem,
  CredentialRequest,
  CredentialVault,
  SkillItem,
  SkillLibrary,
} from '../shared/contracts.mts';
interface CredentialDraft {
  id: string | null;
  name: string;
  service: string;
  username: string;
  requestId: string | null;
  reason: string;
}
interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  files: string;
  enabled: boolean;
  editing: boolean;
  assets: SkillAssetMetadata[];
  path?: string;
}
interface ImportPreview {
  id: string;
  source: string;
  name: string;
  description: string;
  instructions: string;
  expiresAt: number;
  files: { path: string; size: number }[];
}
interface ImportDraft {
  key: number;
  scope: string;
  mode: 'github' | 'file';
  url: string;
  file: File | null;
  name: string;
  enabled: boolean;
  preview: ImportPreview | null;
  pending: 'preview' | 'commit' | null;
  error: string;
  unknown: boolean;
  detailsOpen: boolean;
}
interface ManagedOptions {
  getState: () => UiState | null;
  getModal?: () => UiModal | null;
  request: ApiRequest;
  download?: (file: Attachment) => Promise<{ saved: boolean }>;
  render: () => void;
  toast: (message: string) => void;
  openModal: (modal: UiModal) => void;
  closeModal: () => void;
  document?: Document;
  connected?: () => boolean;
  confirm?: (message: string) => boolean;
  icon?: (name: string) => string;
}
const isImportPreviewFile = (value: unknown): value is { path: string; size: number } =>
  isRecord(value) && typeof value.path === 'string' && isSafeInteger(value.size) && value.size >= 0;
const isImportPreview = (value: unknown): value is ImportPreview =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  value.id.length <= 128 &&
  typeof value.source === 'string' &&
  typeof value.name === 'string' &&
  typeof value.description === 'string' &&
  typeof value.instructions === 'string' &&
  Array.isArray(value.files) &&
  value.files.length <= SKILL_SUPPORT_FILE_LIMIT + 1 &&
  value.files.every(isImportPreviewFile) &&
  isFiniteNumber(value.expiresAt);
const dataId = (value: string | undefined): string => {
  if (!value) throw Error('Missing record identifier');
  return value;
};
const isSkillAssetMetadata = (value: unknown): value is SkillAssetMetadata =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  value.path.length <= SKILL_RELATIVE_PATH_CHARACTERS &&
  value.mediaType === 'application/octet-stream' &&
  isSafeInteger(value.size) &&
  value.size >= 0 &&
  value.size <= SKILL_FILE_BYTES;
const isCredentialItem = (value: unknown): value is CredentialItem =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.service === 'string' &&
  (value.username === undefined || typeof value.username === 'string');
const isCredentialRequest = (value: unknown): value is CredentialRequest =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.service === 'string' &&
  (value.reason === undefined || typeof value.reason === 'string');
export function credentialsSnapshot(value: unknown): CredentialVault {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isCredentialItem) ||
    (value.requests !== undefined &&
      (!Array.isArray(value.requests) || !value.requests.every(isCredentialRequest)))
  )
    throw Error('Invalid credential metadata');
  return { items: value.items, requests: value.requests ?? [], error: Boolean(value.error) };
}
const isSkillItem = (value: unknown): value is SkillItem =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  typeof value.description === 'string' &&
  typeof value.enabled === 'boolean' &&
  (value.path === undefined || typeof value.path === 'string');
export function skillsSnapshot(value: unknown): SkillLibrary {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isSkillItem))
    throw Error('Invalid skill metadata');
  return { items: value.items, error: Boolean(value.error) };
}
import { localizeMessages } from '../i18n/messages.mts';
import {
  SKILL_SUPPORT_FILE_LIMIT,
  SKILL_RELATIVE_PATH_CHARACTERS,
  SKILL_FILE_BYTES,
  SKILL_TOTAL_BYTES,
  SKILL_ARCHIVE_BYTES,
  SKILL_EDITOR_FILE_BYTES,
  SKILL_EDITOR_TOTAL_BYTES,
  SKILL_EDITOR_JSON_BYTES,
} from './skill-limits.mts';
const skillFileMiB = SKILL_FILE_BYTES / (1024 * 1024),
  skillTotalMiB = SKILL_TOTAL_BYTES / (1024 * 1024),
  skillArchiveMiB = SKILL_ARCHIVE_BYTES / (1024 * 1024),
  skillEditorFileKiB = SKILL_EDITOR_FILE_BYTES / 1024,
  skillEditorTotalMiB = SKILL_EDITOR_TOTAL_BYTES / (1024 * 1024);

const baseCopy = {
  zh: {
    credentials: '凭据保险箱',
    credentialsHint: '密码、Token 和 API Key 加密保存在工作电脑中。界面只显示名称与账号。',
    credentialsEmpty: '尚未保存凭据。',
    credentialsOffline: '先连接工作电脑，才能管理凭据和技能。',
    credentialAdd: '添加凭据',
    credentialEdit: '编辑凭据',
    credentialName: '名称',
    credentialService: '服务或网站',
    credentialUsername: '用户名（可选）',
    credentialSecret: '密码、Token 或 API Key',
    credentialKeep: '留空保留已有秘密值；已有值不会显示。',
    credentialSave: '保存凭据',
    credentialContinue: '保存并继续',
    credentialReason: '用途',
    credentialRequest: 'dant 需要一项凭据',
    credentialRequests: '有待提供的凭据',
    credentialProvide: '提供凭据',
    credentialCancel: '取消请求',
    credentialSaved: '凭据已保存',
    credentialRemoved: '凭据已移除',
    credentialFailed: '凭据操作失败，输入已保留。请检查工作电脑连接后重试。',
    credentialRemoveConfirm: '移除此凭据？dant 之后需要时会再次询问。',
    credentialInvalid: '请填写名称、服务和秘密值，并检查长度限制。',
    cancel: '取消',
    close: '关闭',
    edit: '编辑',
    remove: '移除',
    refresh: '刷新',
    loading: '正在读取…',
    skills: '技能',
    skillsHint: '管理工作电脑中的可复用技能。保存只写入文件，不执行脚本。',
    skillsEmpty: '还没有托管技能。',
    skillAdd: '创建技能',
    skillEdit: '编辑技能',
    skillName: '名称（小写字母、数字或连字符）',
    skillDescription: '说明',
    skillInstructions: '使用说明（SKILL.md）',
    skillFiles: '支持文件（JSON）',
    skillFilesHint: `支持 scripts/、references/、assets/ 及根目录 README.md、LICENSE、NOTICE 文件。最多编辑 ${SKILL_SUPPORT_FILE_LIMIT} 个文本文件，每个 ${skillEditorFileKiB} KiB，总计 ${skillEditorTotalMiB} MiB。较大文本和其他格式的文件会作为只读支持文件保留。`,
    skillAssets: '只读支持文件',
    skillAssetsHint:
      '这些文件会原样保留并包含在 ZIP 中。较大文本和其他格式的文件在此编辑器中只读。',
    skillEnabled: '启用此技能',
    skillSave: '保存技能',
    skillSaved: '技能已保存；未执行支持脚本。',
    skillRemoved: '技能已移除',
    skillFailed: '技能操作失败，现有文件与输入已保留。',
    skillInvalid: '请检查技能名称、说明及正文；说明最多 1000 字节，正文最多 48 KiB。',
    skillFilesInvalid:
      '支持文件须为合法 JSON 对象：路径为 scripts/、references/、assets/ 或 README.md、LICENSE、NOTICE，值为文本，并符合数量及大小限制。',
    skillRemoveConfirm: '移除此托管技能及其支持文件？',
    enabled: '已启用',
    disabled: '已停用',
    managedPath: '工作电脑中的路径',
    save: '保存',
    pending: '正在保存…',
  },
  en: {
    credentials: 'Credential vault',
    credentialsHint:
      'Passwords, tokens and API keys are encrypted on the work computer. Only names and account details appear here.',
    credentialsEmpty: 'No saved credentials yet.',
    credentialsOffline: 'Connect the work computer to manage credentials and skills.',
    credentialAdd: 'Add credential',
    credentialEdit: 'Edit credential',
    credentialName: 'Name',
    credentialService: 'Service or website',
    credentialUsername: 'Username (optional)',
    credentialSecret: 'Password, token or API key',
    credentialKeep: 'Leave blank to keep the current secret. Existing values are never shown.',
    credentialSave: 'Save credential',
    credentialContinue: 'Save and continue',
    credentialReason: 'Purpose',
    credentialRequest: 'dant needs a credential',
    credentialRequests: 'Credentials awaiting your input',
    credentialProvide: 'Provide credential',
    credentialCancel: 'Cancel request',
    credentialSaved: 'Credential saved',
    credentialRemoved: 'Credential removed',
    credentialFailed:
      'The credential action failed. Your input was kept. Check the work computer connection and try again.',
    credentialRemoveConfirm: 'Remove this credential? dant will ask again if it needs it.',
    credentialInvalid: 'Enter the name, service and secret, and check their length limits.',
    cancel: 'Cancel',
    close: 'Close',
    edit: 'Edit',
    remove: 'Remove',
    refresh: 'Refresh',
    loading: 'Loading…',
    skills: 'Skills',
    skillsHint:
      'Manage reusable skills on the work computer. Saving writes files; it does not execute scripts.',
    skillsEmpty: 'No managed skills yet.',
    skillAdd: 'Create skill',
    skillEdit: 'Edit skill',
    skillName: 'Name (lowercase letters, numbers or hyphens)',
    skillDescription: 'Description',
    skillInstructions: 'Instructions (SKILL.md)',
    skillFiles: 'Supporting text files (JSON)',
    skillFilesHint: `Use scripts/, references/ or assets/ paths, or root README.md, LICENSE and NOTICE files. Edit up to ${SKILL_SUPPORT_FILE_LIMIT} text files, ${skillEditorFileKiB} KiB each, ${skillEditorTotalMiB} MiB total. Larger text and other file formats are preserved as read-only supporting files.`,
    skillAssets: 'Preserved supporting files',
    skillAssetsHint:
      'These files are preserved byte for byte and included in the ZIP. Large text files and other file formats are read-only in this editor.',
    skillEnabled: 'Enable this skill',
    skillSave: 'Save skill',
    skillSaved: 'Skill saved. Supporting scripts have not been executed.',
    skillRemoved: 'Skill removed',
    skillFailed: 'The skill action failed. Existing files and your input were kept.',
    skillInvalid:
      'Check the skill name, description and instructions. Description: 1000 bytes; instructions: 48 KiB maximum.',
    skillFilesInvalid:
      'Supporting files must be a JSON object with text values under scripts/, references/ or assets/, or root README.md, LICENSE and NOTICE, within the file-count and size limits.',
    skillRemoveConfirm: 'Remove this managed skill and its supporting files?',
    enabled: 'Enabled',
    disabled: 'Disabled',
    managedPath: 'Path on work computer',
    save: 'Save',
    pending: 'Saving…',
  },
};

export const managedMessages = {
  en: Object.assign(
    baseCopy.en,
    {
      skillsPageHint: 'Reusable tools and workflows created by you and dant.',
      skillsSearch: 'Search skills',
      skillsSearchPlaceholder: 'Search names or descriptions…',
      skillsNoMatch: 'No matching skills.',
      skillsCount: '{count} skills',
      skillsOffline: 'Connect the work computer to create or change skills.',
    },
    {
      skillImport: 'Import skill',
      skillImportGitHub: 'GitHub',
      skillImportLocal: 'Local file',
      skillImportSource: 'Skill source',
      skillImportURL: 'GitHub skill URL',
      skillImportFile: 'SKILL.md or ZIP file',
      skillImportFileHint: `Choose SKILL.md or a ZIP containing one skill, up to ${skillArchiveMiB} MiB.`,
      skillImportPreview: 'Preview skill',
      skillImportPreviewing: 'Loading preview…',
      skillImportSaving: 'Importing…',
      skillImportReady: 'Skill preview',
      skillImportFiles: 'Included files',
      skillImportAgain: 'Preview again',
      skillImportInvalidSource:
        'Enter a public GitHub skill URL, or choose a local SKILL.md / ZIP.',
      skillImportNotFound: 'Skill not found. Check the URL or file.',
      skillImportInvalidSkill: 'Invalid skill format. Check SKILL.md and its supporting files.',
      skillImportUnsupported: 'Use a public GitHub skill, SKILL.md or ZIP file.',
      skillImportLimit: 'The skill or file exceeds its size limit. Choose a smaller skill.',
      skillImportExists: 'A skill with this name already exists. Change the name and import again.',
      skillImportExpired: 'The preview expired. Preview the skill again.',
      skillImportFetchFailed:
        'The skill could not be read. Your input was kept. Check the connection and preview again.',
      skillImportBusy: 'An import is already being processed. Try again shortly.',
      skillImportUnknown:
        'The import outcome is unconfirmed. Refresh the skill list to check the result; preview again before another import.',
      skillImportFailed:
        'The skill could not be imported. Your preview and input were kept. Check the work computer connection.',
    },
    {
      skillExport: 'Download ZIP',
      skillExportStarted: 'ZIP saved',
      skillExportFailed:
        'The skill ZIP could not be downloaded. Check the connection and try again.',
      skillExportUnsupported:
        'The skill files could not be encoded for export. Existing files were preserved.',
      skillExportCredentials:
        'This skill contains a saved credential. Remove the credential from the skill before exporting; existing files were preserved.',
    },
    {
      skillReadLimit: `This skill exceeds the supported limits (${SKILL_SUPPORT_FILE_LIMIT} supporting files, ${skillFileMiB} MiB each, ${skillTotalMiB} MiB total). Reduce the file count or size on the work computer, then retry. Existing files were not changed.`,
    },
  ),
  zh: Object.assign(
    baseCopy.zh,
    {
      skillsPageHint: '你和 dant 创建的可复用工具与流程。',
      skillsSearch: '搜索技能',
      skillsSearchPlaceholder: '搜索名称或说明…',
      skillsNoMatch: '没有匹配的技能。',
      skillsCount: '{count} 个技能',
      skillsOffline: '先连接工作电脑，才能创建或修改技能。',
    },
    {
      skillImport: '导入技能',
      skillImportGitHub: 'GitHub',
      skillImportLocal: '本地文件',
      skillImportSource: '技能来源',
      skillImportURL: 'GitHub 技能链接',
      skillImportFile: 'SKILL.md 或 ZIP 文件',
      skillImportFileHint: `选择 SKILL.md 或包含一个技能的 ZIP，最大 ${skillArchiveMiB} MiB。`,
      skillImportPreview: '预览技能',
      skillImportPreviewing: '正在读取预览…',
      skillImportSaving: '正在导入…',
      skillImportReady: '技能预览',
      skillImportFiles: '包含的文件',
      skillImportAgain: '重新预览',
      skillImportInvalidSource: '请输入公开 GitHub 技能链接，或选择本地 SKILL.md / ZIP。',
      skillImportNotFound: '没有找到技能，请检查链接或文件。',
      skillImportInvalidSkill: '技能格式无效，请检查 SKILL.md 及支持文件。',
      skillImportUnsupported: '仅支持公开 GitHub 技能、SKILL.md 和 ZIP 文件。',
      skillImportLimit: '技能或文件超过大小限制，请选择更小的技能。',
      skillImportExists: '已有同名技能。请修改名称后再导入。',
      skillImportExpired: '预览已过期，请重新预览。',
      skillImportFetchFailed: '无法读取技能，输入已保留。请检查连接后重新预览。',
      skillImportBusy: '导入正在处理，请稍后重试。',
      skillImportUnknown: '导入结果尚未确认。先刷新技能列表检查结果；再次导入前请重新预览。',
      skillImportFailed: '技能未能导入，预览与输入已保留。请检查工作电脑连接。',
    },
    {
      skillExport: '下载 ZIP',
      skillExportStarted: 'ZIP 已保存',
      skillExportFailed: '技能 ZIP 未能下载。请检查连接后重试。',
      skillExportUnsupported: '技能文件未能编码导出，现有文件已保留。',
      skillExportCredentials: '技能包含已保存的凭据。请先移除技能中的凭据再导出；现有文件已保留。',
    },
    {
      skillReadLimit: `技能超过支持范围（最多 ${SKILL_SUPPORT_FILE_LIMIT} 个支持文件、每个 ${skillFileMiB} MiB、总计 ${skillTotalMiB} MiB）。请在工作电脑中减少文件数量或大小，再重试；现有文件未被更改。`,
    },
  ),
};

const bytes = (value: string) => new TextEncoder().encode(value).length;
export function parseSkillFiles(text: string, instructions = ''): Record<string, string> {
  const files: unknown = JSON.parse(text || '{}');
  if (!isRecord(files) || Object.keys(files).length > SKILL_SUPPORT_FILE_LIMIT)
    throw Error('skillFilesInvalid');
  let total = bytes(instructions);
  for (const [name, value] of Object.entries(files)) {
    if (
      name.length > 180 ||
      !/^(?:(?:scripts|references|assets)\/|README\.md$|(?:LICENSE|NOTICE)(?:\.(?:txt|md))?$)/.test(
        name,
      ) ||
      name.includes('\\') ||
      name.includes('\0') ||
      name
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.includes(':')) ||
      typeof value !== 'string' ||
      value.includes('\0') ||
      bytes(value) > SKILL_EDITOR_FILE_BYTES
    )
      throw Error('skillFilesInvalid');
    total += bytes(value);
  }
  if (
    total > SKILL_EDITOR_TOTAL_BYTES ||
    bytes(JSON.stringify({ instructions, files })) > SKILL_EDITOR_JSON_BYTES
  )
    throw Error('skillFilesInvalid');
  return files as Record<string, string>;
}

export function createManagedSettings({
  getState,
  getModal = () => null,
  request,
  download,
  render,
  toast,
  openModal,
  closeModal,
  document = globalThis.document,
  connected = () => true,
  confirm = (message) => globalThis.confirm(message),
  icon = () => '',
}: ManagedOptions) {
  let credentialDraft: CredentialDraft | null = null,
    skillDraft: SkillDraft | null = null,
    importDraft: ImportDraft | null = null,
    importSequence = 0,
    busy = false,
    loading = false,
    credentialError = '',
    skillError = '',
    skillSearch = '',
    navigationGeneration = 0,
    lastSkillItems: SkillItem[] = [],
    lastSkillScope: string | null = null,
    skillPathScope: string | null = null;
  const dismissed = new Set<string>(),
    expandedSkillPaths = new Set<string>();
  const tr = (key: string): string => {
    const words = localizeMessages(managedMessages, getState()?.settings?.language);
    return Object.hasOwn(words, key) ? words[key as keyof typeof words] : key;
  };
  const online = () => connected() && getState()?.worker?.status === 'online';
  const credentials = () => getState()?.credentials || { items: [], requests: [] };
  const skills = () => {
    const data = getState()?.skills || { items: [] },
      current = scope();
    if (data.error) return { ...data, items: lastSkillScope === current ? lastSkillItems : [] };
    lastSkillItems = Array.isArray(data.items) ? data.items : [];
    lastSkillScope = current;
    return { ...data, items: lastSkillItems };
  };
  const scope = () => {
    const state = getState(),
      vm = state?.settings?.vm;
    return JSON.stringify([
      state?.conversationId ?? null,
      vm?.host ?? null,
      vm?.user ?? null,
      vm?.port ?? null,
      vm?.keyPath ?? null,
    ]);
  };
  const owner = () => ({ scope: scope(), generation: navigationGeneration, modal: getModal() });
  const owns = (value: { scope: string; generation: number; modal: UiModal | null }) =>
    value.scope === scope() &&
    value.generation === navigationGeneration &&
    value.modal === getModal();
  const field = (form: HTMLFormElement | null, name: string): HTMLInputElement | null =>
    form?.querySelector<HTMLInputElement>('[name="' + name + '"]') ?? null;
  const requiredField = (form: HTMLFormElement, name: string): HTMLInputElement => {
    const node = field(form, name);
    if (!node) throw Error('Required form field is missing');
    return node;
  };
  const clearSecret = () => {
    const input = document.querySelector<HTMLInputElement>('#credential-secret');
    if (input) input.value = '';
  };
  const fail = (kind: string, key: string) => {
    if (kind === 'credential') credentialError = key;
    else skillError = key;
    render();
  };
  const control = (label: string, attr: string, disabled = false) =>
    `<button type="button" class="text-btn" ${attr} ${disabled ? 'disabled' : ''}>${tr(label)}</button>`;
  function credentialEditor(
    item: Partial<CredentialItem> = {},
    requestItem: CredentialRequest | null = null,
  ) {
    clearSecret();
    credentialError = '';
    credentialDraft = {
      id: item.id || null,
      name: requestItem?.name || item.name || '',
      service: requestItem?.service || item.service || '',
      username: item.username || '',
      requestId: requestItem?.id || null,
      reason: requestItem?.reason || '',
    };
    openModal({ type: 'credential', key: requestItem?.id || item.id || 'new' });
  }
  async function load() {
    if (!online() || loading) return;
    const original = scope();
    loading = true;
    render();
    try {
      const [vault, library] = await Promise.allSettled([
        request('/credentials'),
        request('/skills'),
      ]);
      if (original !== scope()) return;
      if (vault.status === 'fulfilled') {
        const state = getState();
        if (state) state.credentials = credentialsSnapshot(vault.value);
        credentialError = '';
      } else credentialError = 'credentialFailed';
      if (library.status === 'fulfilled') {
        const state = getState();
        if (state) state.skills = skillsSnapshot(library.value);
        skillError = '';
      } else skillError = 'skillFailed';
    } finally {
      loading = false;
      render();
    }
  }
  async function loadSkills() {
    if (!online() || loading) return;
    const original = scope();
    loading = true;
    render();
    try {
      const result = skillsSnapshot(await request('/skills'));
      if (original === scope()) {
        if (result.error) skillError = 'skillFailed';
        else {
          const state = getState();
          if (state) state.skills = skillsSnapshot(result);
          skillError = '';
        }
      }
    } catch {
      if (original === scope()) skillError = 'skillFailed';
    } finally {
      loading = false;
      render();
    }
  }
  async function mutate(kind: string, route: string, options: ApiOptions) {
    if (!online()) {
      fail(kind, 'credentialsOffline');
      return false;
    }
    if (busy) return false;
    const original = scope();
    busy = true;
    render();
    try {
      await request(route, options);
      if (original !== scope()) return true;
      try {
        const result = await request(kind === 'credential' ? '/credentials' : '/skills');
        if (original === scope()) {
          if (kind === 'credential') {
            const state = getState();
            if (state) state.credentials = credentialsSnapshot(result);
            credentialError = '';
          } else {
            const state = getState();
            if (state) state.skills = skillsSnapshot(result);
            skillError = '';
          }
        }
      } catch {
        /* A confirmed write must not become a retryable create when refresh fails. */
      }
      return true;
    } catch {
      if (original === scope())
        fail(kind, kind === 'credential' ? 'credentialFailed' : 'skillFailed');
      return false;
    } finally {
      busy = false;
      render();
    }
  }
  function renderCredentials() {
    const data = credentials(),
      disabled = !online() || busy || Boolean(importDraft?.pending);
    return `<section class="settings-section setting-card credentials-settings"><div class="card-label"><h2>${tr('credentials')}</h2></div><div class="card-content"><p class="card-description">${tr('credentialsHint')}</p>${!online() ? `<p class="muted">${tr('credentialsOffline')}</p>` : ''}${credentialError || data.error ? `<p class="error" role="status">${tr(credentialError || 'credentialFailed')}</p>` : ''}<div class="managed-list">${(data.items || []).map((item) => `<div class="managed-item" data-key="credential-${escape(item.id)}"><div><strong>${escape(item.name)}</strong><small>${escape(item.service)}${item.username ? ' · ' + escape(item.username) : ''}</small></div><div class="managed-actions">${control('edit', `data-credential-edit="${escape(item.id)}"`, disabled)}${control('remove', `data-credential-remove="${escape(item.id)}"`, disabled)}</div></div>`).join('') || `<p class="muted">${tr('credentialsEmpty')}</p>`}</div>${renderRequests()}<div class="inline-actions">${control('credentialAdd', 'data-credential-add', disabled)}${control('refresh', 'data-managed-refresh', disabled || loading)}</div>${loading ? `<p class="muted">${tr('loading')}</p>` : ''}</div></section>`;
  }
  function renderSkills() {
    const data = skills(),
      disabled = !online() || busy || Boolean(importDraft?.pending);
    return `<section class="settings-section setting-card skills-settings"><div class="card-label"><h2>${tr('skills')}</h2></div><div class="card-content"><p class="card-description">${tr('skillsHint')}</p>${!online() ? `<p class="muted">${tr('credentialsOffline')}</p>` : ''}${skillError || data.error ? `<p class="error" role="status">${tr(skillError || 'skillFailed')}</p>` : ''}<div class="managed-list">${(data.items || []).map((item) => `<div class="managed-item" data-key="skill-${escape(item.name)}"><div><strong>${escape(item.name)}</strong><small>${escape(item.description)}</small><small>${tr(item.enabled ? 'enabled' : 'disabled')}</small><small class="managed-path">${tr('managedPath')}: ${escape(item.path || '')}</small></div><div class="managed-actions"><label class="managed-toggle"><input type="checkbox" data-skill-toggle="${escape(item.name)}" aria-label="${escape(item.name + ' · ' + tr('skillEnabled'))}" ${item.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${tr(item.enabled ? 'enabled' : 'disabled')}</label>${control('skillExport', `data-skill-export="${escape(item.name)}"`, disabled || typeof download !== 'function')}${control('edit', `data-skill-edit="${escape(item.name)}"`, disabled)}${control('remove', `data-skill-remove="${escape(item.name)}"`, disabled)}</div></div>`).join('') || `<p class="muted">${tr('skillsEmpty')}</p>`}</div><div class="inline-actions">${control('skillAdd', 'data-skill-add', disabled)}${control('skillImport', 'data-skill-import', disabled)}${control('refresh', 'data-managed-refresh', disabled || loading)}</div></div></section>`;
  }
  function renderSkillPage() {
    const current = scope();
    if (skillPathScope !== current) {
      expandedSkillPaths.clear();
      skillPathScope = current;
    } else
      document.querySelectorAll<HTMLInputElement>('[data-skill-path]').forEach((node) => {
        if (node.hasAttribute('open')) expandedSkillPaths.add(dataId(node.dataset.skillPath));
        else expandedSkillPaths.delete(dataId(node.dataset.skillPath));
      });
    const data = skills(),
      items = Array.isArray(data.items) ? data.items : [],
      query = skillSearch.normalize('NFKC').toLocaleLowerCase().trim(),
      matches = items.filter((item) =>
        (item.name + ' ' + item.description).normalize('NFKC').toLocaleLowerCase().includes(query),
      ),
      disabled = !online() || busy || Boolean(importDraft?.pending);
    const icon =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7M14 17.5h7" stroke-linecap="round"/></svg>';
    return `<section class="skills-page" aria-labelledby="skills-page-title"><div class="skills-page-heading"><div><h1 id="skills-page-title">${tr('skills')}</h1><p>${tr('skillsPageHint')}</p></div><div class="skills-page-actions">${control('skillImport', 'data-skill-import', disabled)}<button type="button" class="text-btn primary skill-page-add" data-skill-add ${disabled ? 'disabled' : ''}><span aria-hidden="true">+</span>${tr('skillAdd')}</button></div></div><div class="skills-page-toolbar"><label class="skills-search"><span>${tr('skillsSearch')}</span><input id="skills-search" type="search" value="${escape(skillSearch)}" placeholder="${tr('skillsSearchPlaceholder')}" maxlength="200" autocomplete="off" aria-label="${tr('skillsSearch')}"></label><span class="skills-count">${tr('skillsCount').replace('{count}', String(matches.length))}</span>${control('refresh', 'data-skills-refresh', disabled || loading)}</div><p class="skills-save-hint">${tr('skillsHint')}</p>${!online() ? `<p class="skills-page-notice" role="status">${tr('skillsOffline')}</p>` : ''}${skillError || data.error ? `<p class="error skills-page-notice" role="status">${tr(skillError || 'skillFailed')}</p>` : ''}${loading ? `<p class="skills-page-notice" role="status">${tr('loading')}</p>` : ''}<div class="skills-grid" aria-busy="${loading}">${matches.map((item) => `<article class="skill-card ${item.enabled ? 'enabled' : 'disabled'}" data-key="skill-card-${escape(item.name)}"><div class="skill-card-heading"><div class="skill-card-icon">${icon}</div><label class="skill-card-toggle"><span>${tr(item.enabled ? 'enabled' : 'disabled')}</span><input type="checkbox" role="switch" data-skill-toggle="${escape(item.name)}" aria-label="${escape(item.name + ' · ' + tr('skillEnabled'))}" aria-checked="${Boolean(item.enabled)}" ${item.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label></div><h2>${escape(item.name)}</h2><p class="skill-card-description">${escape(item.description)}</p><div class="skill-card-footer"><details class="skill-card-path" data-skill-path="${escape(item.name)}" ${expandedSkillPaths.has(item.name) ? 'open' : ''}><summary>${tr('managedPath')}</summary><code>${escape(item.path || '')}</code></details><div class="skill-card-actions">${control('skillExport', `data-skill-export="${escape(item.name)}"`, disabled || typeof download !== 'function')}${control('edit', `data-skill-edit="${escape(item.name)}"`, disabled)}${control('remove', `data-skill-remove="${escape(item.name)}"`, disabled)}</div></div></article>`).join('')}</div>${!matches.length && !loading ? `<div class="skills-page-empty">${icon}<p>${tr(query ? 'skillsNoMatch' : 'skillsEmpty')}</p>${!query && !items.length ? control('skillAdd', 'data-skill-add', disabled) : ''}</div>` : ''}</section>`;
  }
  function renderRequests() {
    const items = credentials().requests || [];
    return items.length
      ? `<div class="credential-requests" role="status"><strong>${tr('credentialRequests')}</strong>${items.map((item) => `<div data-key="request-${escape(item.id)}"><span>${escape(item.name)} · ${escape(item.service)}</span>${control('credentialProvide', `data-credential-request="${escape(item.id)}"`, !online() || busy)}</div>`).join('')}</div>`
      : '';
  }
  function syncModal(current: UiModal | null, page: string): UiModal | null {
    if (current?.type === 'skill-import' && importDraft?.scope !== scope()) {
      onClose(current);
      return null;
    }
    if (
      current?.type === 'credential' &&
      credentialDraft?.requestId &&
      !credentials().requests?.some((item) => item.id === credentialDraft?.requestId)
    ) {
      clearSecret();
      credentialDraft = null;
      return null;
    }
    if (!current && page === 'chat' && online()) {
      const item = credentials().requests?.find((item) => !dismissed.has(item.id));
      if (item) {
        credentialDraft = {
          id: null,
          name: item.name,
          service: item.service,
          username: '',
          requestId: item.id,
          reason: item.reason || '',
        };
        credentialError = '';
        return { type: 'credential', key: item.id };
      }
    }
    return current;
  }
  function onClose(current: UiModal | null) {
    navigationGeneration++;
    if (current?.type === 'credential') {
      if (credentialDraft?.requestId) dismissed.add(credentialDraft?.requestId);
      clearSecret();
      credentialDraft = null;
      credentialError = '';
    }
    if (current?.type === 'skill') {
      skillDraft = null;
      skillError = '';
    }
    if (current?.type === 'skill-import') {
      if (importDraft?.pending !== 'commit')
        discardImportPreview(importDraft?.preview, importDraft?.scope);
      importDraft = null;
    }
  }
  function renderModal(current: UiModal | null) {
    if (current?.type === 'skill-import' && importDraft) return renderImport();
    if (current?.type === 'credential' && credentialDraft) {
      const draft = credentialDraft,
        locked = !online() || busy;
      return shell(
        tr(draft.requestId ? 'credentialRequest' : draft.id ? 'credentialEdit' : 'credentialAdd'),
        'credential-' + current.key,
        `<form id="credential-form" autocomplete="off"><p class="card-description">${tr('credentialsHint')}</p>${draft.reason ? `<p class="credential-purpose"><strong>${tr('credentialReason')}</strong> ${escape(draft.reason)}</p>` : ''}<div class="form-grid"><label>${tr('credentialName')}<input name="name" value="${escape(draft.name)}" maxlength="100" required ${draft.requestId ? 'readonly' : ''}></label><label>${tr('credentialService')}<input name="service" value="${escape(draft.service)}" maxlength="200" required ${draft.requestId ? 'readonly' : ''}></label><label class="wide">${tr('credentialUsername')}<input name="username" value="${escape(draft.username)}" maxlength="300" autocomplete="off"></label><label class="wide">${tr('credentialSecret')}<input id="credential-secret" name="secret" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="16000" ${draft.id ? '' : 'required'}></label></div>${draft.id ? `<p class="muted">${tr('credentialKeep')}</p>` : ''}${credentialError ? `<p class="error" role="status">${tr(credentialError)}</p>` : ''}<div class="form-actions">${draft.requestId ? control('credentialCancel', 'data-credential-cancel', locked) : control('cancel', 'data-action="close-modal"', busy)}<button type="submit" class="text-btn primary" ${locked ? 'disabled' : ''}>${tr(busy ? 'pending' : draft.requestId ? 'credentialContinue' : 'credentialSave')}</button></div></form>`,
      );
    }
    if (current?.type === 'skill' && skillDraft) {
      const draft = skillDraft,
        assetSummary = draft.assets.length
          ? `<section class="skill-asset-files"><strong>${tr('skillAssets')}</strong><p class="muted">${tr('skillAssetsHint')}</p><ul>${draft.assets.map((asset) => `<li><code>${escape(asset.path)}</code> · ${asset.size} B</li>`).join('')}</ul></section>`
          : '';
      return shell(
        tr(draft.editing ? 'skillEdit' : 'skillAdd'),
        'skill-' + current.key,
        `<form id="skill-form"><p class="card-description">${tr('skillsHint')}</p><label>${tr('skillName')}<input name="name" value="${escape(draft.name)}" pattern="[a-z0-9][a-z0-9-]{0,63}" maxlength="64" required ${draft.editing ? 'readonly' : ''}></label><label>${tr('skillDescription')}<textarea name="description" rows="2" required>${escape(draft.description)}</textarea></label><label>${tr('skillInstructions')}<textarea name="instructions" rows="10" required>${escape(draft.instructions)}</textarea></label><details class="skill-files"><summary>${tr('skillFiles')}</summary><p class="muted">${tr('skillFilesHint')}</p><textarea name="files" rows="6" spellcheck="false" aria-label="${tr('skillFiles')}">${escape(draft.files)}</textarea></details>${assetSummary}<label class="managed-toggle"><input name="enabled" type="checkbox" ${draft.enabled ? 'checked' : ''}>${tr('skillEnabled')}</label>${draft.path ? `<p class="muted managed-path">${tr('managedPath')}: ${escape(draft.path)}</p>` : ''}${skillError ? `<p class="error" role="status">${tr(skillError)}</p>` : ''}<div class="form-actions">${control('cancel', 'data-action="close-modal"', busy)}<button type="submit" class="text-btn primary" ${!online() || busy ? 'disabled' : ''}>${tr(busy ? 'pending' : 'skillSave')}</button></div></form>`,
      );
    }
    return null;
  }
  function shell(title: string, key: string, body: string, locked = busy) {
    return `<div class="modal-backdrop" data-key="${escape(key)}"><section class="dialog managed-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><h2 id="dialog-title">${title}</h2><button type="button" class="icon-btn" data-action="close-modal" title="${tr('close')}" aria-label="${tr('close')}" ${locked ? 'disabled' : ''}>${icon('x') || '×'}</button></div><div class="dialog-body">${body}</div></section></div>`;
  }
  function importEditor() {
    if (!online() || busy || importDraft?.pending) return;
    importDraft = {
      key: ++importSequence,
      scope: scope(),
      mode: 'github',
      url: '',
      file: null,
      name: '',
      enabled: true,
      preview: null,
      pending: null,
      error: '',
      unknown: false,
      detailsOpen: false,
    };
    openModal({ type: 'skill-import', key: importDraft.key });
  }
  function discardImportPreview(preview: unknown, originalScope: string | undefined) {
    if (
      originalScope !== scope() ||
      !online() ||
      !isRecord(preview) ||
      typeof preview.id !== 'string' ||
      !preview.id ||
      preview.id.length > 128
    )
      return;
    const previewId = preview.id;
    void Promise.resolve()
      .then(() => {
        if (originalScope === scope() && online())
          return request('/skills/import/previews/' + encodeURIComponent(previewId), {
            method: 'DELETE',
          });
      })
      .catch(() => {});
  }
  function importError(cause: unknown, fallback: string): string {
    const error = requestError(cause);
    const codes = {
      invalid_source: 'skillImportInvalidSource',
      not_found: 'skillImportNotFound',
      invalid_skill: 'skillImportInvalidSkill',
      unsupported_file: 'skillImportUnsupported',
      size_limit: 'skillImportLimit',
      name_exists: 'skillImportExists',
      expired: 'skillImportExpired',
      fetch_failed: 'skillImportFetchFailed',
      import_busy: 'skillImportBusy',
    };
    return typeof error.code === 'string' && Object.hasOwn(codes, error.code)
      ? codes[error.code as keyof typeof codes]
      : fallback;
  }
  function captureImport(form: HTMLFormElement | null) {
    if (!importDraft || importDraft.pending) return;
    const url = field(form, 'url'),
      name = field(form, 'name'),
      enabled = field(form, 'enabled');
    if (url && importDraft.url !== url.value) {
      discardImportPreview(importDraft.preview, importDraft.scope);
      importDraft.url = url.value;
      importDraft.preview = null;
      importDraft.error = '';
      importDraft.unknown = false;
    }
    if (name) importDraft.name = name.value;
    if (enabled) importDraft.enabled = enabled.checked;
  }
  function renderImport() {
    const draft = importDraft;
    if (!draft) return '';
    const preview = draft.preview,
      locked = !online() || busy || Boolean(draft.pending),
      expired = preview && preview.expiresAt <= Date.now(),
      error = draft.error || (expired ? 'skillImportExpired' : '');
    const details = document.querySelector<HTMLInputElement>('#skill-import-instructions');
    if (details && details.closest('form')?.dataset.importKey === String(draft.key))
      draft.detailsOpen = details.hasAttribute('open');
    const source =
      draft.mode === 'github'
        ? `<label>${tr('skillImportURL')}<input name="url" type="url" value="${escape(draft.url)}" placeholder="https://github.com/owner/repo/tree/main/skill" maxlength="2048" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}></label>`
        : `<label>${tr('skillImportFile')}<input id="skill-import-file" name="file" type="file" accept=".md,.zip,text/markdown,application/zip" ${locked ? 'disabled' : ''}></label>${draft.file ? `<p class="skill-import-selected">${escape(draft.file.name)}</p>` : ''}<p class="muted">${tr('skillImportFileHint')}</p>`;
    return shell(
      tr('skillImport'),
      'skill-import-' + draft.key,
      `<form id="skill-import-form" data-import-key="${draft.key}" aria-busy="${Boolean(draft.pending)}"><p class="card-description">${tr('skillsHint')}</p><div class="skill-import-sources segmented" role="group" aria-label="${tr('skillImportSource')}"><button type="button" data-skill-import-source="github" class="${draft.mode === 'github' ? 'selected' : ''}" aria-pressed="${draft.mode === 'github'}" ${locked ? 'disabled' : ''}>${tr('skillImportGitHub')}</button><button type="button" data-skill-import-source="file" class="${draft.mode === 'file' ? 'selected' : ''}" aria-pressed="${draft.mode === 'file'}" ${locked ? 'disabled' : ''}>${tr('skillImportLocal')}</button></div>${source}<div class="skill-import-preview-action">${control(draft.pending === 'preview' ? 'skillImportPreviewing' : preview || draft.unknown ? 'skillImportAgain' : 'skillImportPreview', 'data-skill-import-preview', locked)}</div>${preview ? `<section class="skill-import-preview" aria-label="${tr('skillImportReady')}"><small class="skill-import-origin">${escape(preview.source)}</small><label>${tr('skillName')}<input name="name" value="${escape(draft.name)}" pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?" maxlength="64" required ${locked || draft.unknown ? 'disabled' : ''}></label><div class="skill-import-description"><strong>${tr('skillDescription')}</strong><p>${escape(preview.description)}</p></div><details id="skill-import-instructions" ${draft.detailsOpen ? 'open' : ''}><summary>${tr('skillInstructions')}</summary><pre>${escape(preview.instructions)}</pre></details><div class="skill-import-files"><strong>${tr('skillImportFiles')}</strong><ul>${preview.files.map((file) => `<li><code>${escape(file.path)}</code><span>${file.size < 1024 ? file.size + ' B' : (file.size / 1024).toFixed(1) + ' KiB'}</span></li>`).join('')}</ul></div><label class="managed-toggle"><input name="enabled" type="checkbox" ${draft.enabled ? 'checked' : ''} ${locked || draft.unknown ? 'disabled' : ''}>${tr('skillEnabled')}</label></section>` : ''}${error ? `<p class="error" role="status">${tr(error)}</p>` : ''}<div class="form-actions">${draft.unknown ? control('refresh', 'data-skill-import-refresh', locked || loading) : ''}${control('cancel', 'data-action="close-modal"', Boolean(draft.pending))}${preview ? `<button type="submit" class="text-btn primary" ${locked || draft.unknown || expired ? 'disabled' : ''}>${tr(draft.pending === 'commit' ? 'skillImportSaving' : 'skillImport')}</button>` : ''}</div></form>`,
      Boolean(draft.pending),
    );
  }
  async function previewImport(form: HTMLFormElement | null) {
    const draft = importDraft;
    if (!draft || !online() || busy || draft.pending || draft.scope !== scope()) return;
    captureImport(form);
    let body;
    if (draft.mode === 'github') {
      if (!draft.url.trim() || draft.url.length > 2048) {
        draft.error = 'skillImportInvalidSource';
        render();
        return;
      }
      body = { url: draft.url.trim() };
    } else {
      if (!draft.file) {
        draft.error = 'skillImportInvalidSource';
        render();
        return;
      }
      if (draft.file.size > SKILL_ARCHIVE_BYTES) {
        draft.error = 'skillImportLimit';
        render();
        return;
      }
      body = new FormData();
      body.append('file', draft.file, draft.file.name);
    }
    const operation = owner();
    discardImportPreview(draft.preview, draft.scope);
    draft.preview = null;
    draft.pending = 'preview';
    draft.error = '';
    render();
    try {
      const preview = await request('/skills/import/preview', { method: 'POST', body });
      if (importDraft !== draft || !owns(operation)) {
        discardImportPreview(preview, operation.scope);
        return;
      }
      if (!isImportPreview(preview) || preview.expiresAt <= Date.now())
        throw Error('Invalid skill preview');
      draft.preview = preview;
      draft.name = preview.name;
      draft.unknown = false;
      draft.detailsOpen = false;
    } catch (error) {
      if (importDraft === draft && owns(operation))
        draft.error = importError(error, 'skillImportFetchFailed');
    } finally {
      draft.pending = null;
      if (importDraft === draft && owns(operation)) render();
    }
  }
  async function commitImport(form: HTMLFormElement | null) {
    const draft = importDraft;
    if (!draft || !online() || busy || draft.pending || draft.unknown || draft.scope !== scope())
      return;
    captureImport(form);
    if (!draft.preview || draft.preview.expiresAt <= Date.now()) {
      draft.error = 'skillImportExpired';
      render();
      return;
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(draft.name)) {
      draft.error = 'skillInvalid';
      render();
      return;
    }
    const operation = owner(),
      body = { id: draft.preview.id, name: draft.name, enabled: draft.enabled };
    draft.pending = 'commit';
    draft.error = '';
    render();
    try {
      await request('/skills/import', { method: 'POST', body });
      if (importDraft !== draft || !owns(operation)) return;
      try {
        const result = skillsSnapshot(await request('/skills'));
        if (importDraft !== draft || !owns(operation)) return;
        const state = getState();
        if (state) state.skills = skillsSnapshot(result);
        skillError = result.error ? 'skillFailed' : '';
      } catch {
        /* A confirmed import must not become a retryable write when refresh fails. */
      }
      if (importDraft === draft && owns(operation)) {
        importDraft = null;
        closeModal();
        toast(tr('skillSaved'));
      }
    } catch (error) {
      if (importDraft === draft && owns(operation)) {
        const failure = requestError(error);
        draft.unknown = failure.unknownOutcome === true || typeof failure.status !== 'number';
        draft.error = draft.unknown
          ? 'skillImportUnknown'
          : importError(error, 'skillImportFailed');
      }
    } finally {
      draft.pending = null;
      if (importDraft === draft && owns(operation)) render();
    }
  }
  function captureCredential(form: HTMLFormElement) {
    if (!credentialDraft) return;
    for (const key of ['name', 'service', 'username'] as const)
      credentialDraft[key] = requiredField(form, key).value;
  }
  async function saveCredential(form: HTMLFormElement) {
    if (!credentialDraft || !online() || busy) return;
    captureCredential(form);
    const draft = credentialDraft,
      operation = owner(),
      input = requiredField(form, 'secret');
    let secret = input.value;
    if (
      !draft.name.trim() ||
      draft.name.length > 100 ||
      !draft.service.trim() ||
      draft.service.length > 200 ||
      draft.username.length > 300 ||
      secret.length > 16000 ||
      (!draft.id && !secret.trim())
    ) {
      fail('credential', 'credentialInvalid');
      return;
    }
    const body = draft.requestId
        ? { username: draft.username, secret }
        : {
            name: draft.name,
            service: draft.service,
            username: draft.username,
            ...(secret ? { secret } : {}),
          },
      route = draft.requestId
        ? '/credentials/requests/' + encodeURIComponent(draft.requestId)
        : '/credentials' + (draft.id ? '/' + encodeURIComponent(draft.id) : '');
    try {
      if (await mutate('credential', route, { method: draft.id ? 'PATCH' : 'POST', body })) {
        input.value = '';
        if (owns(operation) && credentialDraft === draft) {
          credentialDraft = null;
          closeModal();
        }
        toast(tr('credentialSaved'));
      }
    } finally {
      secret = '';
      delete body.secret;
    }
  }
  function captureSkill(form: HTMLFormElement) {
    if (!skillDraft) return;
    for (const key of ['name', 'description', 'instructions', 'files'] as const)
      skillDraft[key] = requiredField(form, key).value;
    skillDraft.enabled = requiredField(form, 'enabled').checked;
  }
  async function saveSkill(form: HTMLFormElement) {
    if (!skillDraft || !online() || busy) return;
    captureSkill(form);
    const draft = skillDraft,
      operation = owner();
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(draft.name) ||
      !draft.description.trim() ||
      bytes(draft.description) > 1000 ||
      !draft.instructions.trim() ||
      bytes(draft.instructions) > 49152
    ) {
      fail('skill', 'skillInvalid');
      return;
    }
    let files;
    try {
      files = parseSkillFiles(draft.files, draft.instructions);
    } catch {
      fail('skill', 'skillFilesInvalid');
      return;
    }
    const body = {
      description: draft.description,
      instructions: draft.instructions,
      files,
      ...(draft.editing && draft.assets.length ? { preserveBinaryFiles: true } : {}),
      enabled: draft.enabled,
      ...(draft.editing ? {} : { name: draft.name }),
    };
    if (
      await mutate(
        'skill',
        '/skills' + (draft.editing ? '/' + encodeURIComponent(draft.name) : ''),
        { method: draft.editing ? 'PATCH' : 'POST', body },
      )
    ) {
      if (owns(operation) && skillDraft === draft) {
        skillDraft = null;
        closeModal();
      }
      toast(tr('skillSaved'));
    }
  }
  async function editSkill(name: string | undefined) {
    if (!name || !online() || busy) return;
    const operation = owner();
    busy = true;
    render();
    try {
      const item = await request('/skills/' + encodeURIComponent(name));
      if (
        !isRecord(item) ||
        typeof item.name !== 'string' ||
        typeof item.description !== 'string' ||
        typeof item.instructions !== 'string' ||
        typeof item.enabled !== 'boolean' ||
        (item.assets !== undefined &&
          (!Array.isArray(item.assets) ||
            item.assets.length > SKILL_SUPPORT_FILE_LIMIT ||
            !item.assets.every(isSkillAssetMetadata)))
      )
        throw Error('Invalid skill metadata');
      if (!owns(operation)) return;
      skillDraft = {
        name: item.name,
        description: item.description,
        instructions: item.instructions,
        enabled: item.enabled,
        ...(typeof item.path === 'string' ? { path: item.path } : {}),
        editing: true,
        assets: item.assets ?? [],
        files: JSON.stringify(item.files || {}, null, 2),
      };
      skillError = '';
      openModal({ type: 'skill', key: name });
    } catch (error) {
      if (owns(operation))
        fail('skill', requestError(error).code === 'size_limit' ? 'skillReadLimit' : 'skillFailed');
    } finally {
      busy = false;
      render();
    }
  }
  function bind() {
    const click = (selector: string, handler: (node: HTMLElement) => unknown) =>
      document
        .querySelectorAll<HTMLElement>(selector)
        .forEach(
          (node) =>
            (node.onclick = () =>
              Promise.resolve(handler(node)).catch(() =>
                fail(
                  selector.includes('skill') ? 'skill' : 'credential',
                  selector.includes('skill') ? 'skillFailed' : 'credentialFailed',
                ),
              )),
        );
    click('[data-skill-export]', async (node) => {
      if (!online() || busy || typeof download !== 'function') return;
      const original = scope();
      busy = true;
      skillError = '';
      render();
      try {
        const file = await request(
          '/skills/' + encodeURIComponent(dataId(node.dataset.skillExport)) + '/export',
          { method: 'POST', body: {} },
        );
        if (original !== scope()) return;
        const result = await download(attachmentSnapshot(file));
        if (original === scope() && result?.saved) toast(tr('skillExportStarted'));
      } catch (error) {
        if (original === scope()) {
          const code = requestError(error).code;
          fail(
            'skill',
            code === 'size_limit'
              ? 'skillReadLimit'
              : code === 'unsupported_file'
                ? 'skillExportUnsupported'
                : code === 'credentials'
                  ? 'skillExportCredentials'
                  : 'skillExportFailed',
          );
        }
      } finally {
        busy = false;
        render();
      }
    });
    click('[data-managed-refresh]', load);
    click('[data-skills-refresh]', loadSkills);
    click('[data-credential-add]', () => {
      if (online() && !busy) credentialEditor();
    });
    click('[data-credential-edit]', (node) => {
      if (online() && !busy) {
        const item = credentials().items?.find((item) => item.id === node.dataset.credentialEdit);
        if (item) credentialEditor(item);
      }
    });
    click('[data-credential-request]', (node) => {
      if (online() && !busy) {
        const item = credentials().requests?.find(
          (item) => item.id === node.dataset.credentialRequest,
        );
        if (item) credentialEditor({}, item);
      }
    });
    click('[data-credential-remove]', async (node) => {
      if (
        online() &&
        !busy &&
        confirm(tr('credentialRemoveConfirm')) &&
        (await mutate(
          'credential',
          '/credentials/' + encodeURIComponent(dataId(node.dataset.credentialRemove)),
          { method: 'DELETE' },
        ))
      )
        toast(tr('credentialRemoved'));
    });
    click('[data-credential-cancel]', async () => {
      const draft = credentialDraft,
        operation = owner(),
        input = document.querySelector<HTMLInputElement>('#credential-secret'),
        id = draft?.requestId;
      if (
        id &&
        (await mutate('credential', '/credentials/requests/' + encodeURIComponent(id), {
          method: 'DELETE',
        }))
      ) {
        if (input) input.value = '';
        if (owns(operation) && credentialDraft === draft) {
          credentialDraft = null;
          closeModal();
        }
      }
    });
    click('[data-skill-add]', () => {
      if (online() && !busy) {
        skillError = '';
        skillDraft = {
          name: '',
          description: '',
          instructions: '',
          files: '{}',
          enabled: true,
          editing: false,
          assets: [],
        };
        openModal({ type: 'skill', key: 'new' });
      }
    });
    click('[data-skill-edit]', (node) => editSkill(node.dataset.skillEdit));
    click('[data-skill-remove]', async (node) => {
      if (
        online() &&
        !busy &&
        confirm(tr('skillRemoveConfirm')) &&
        (await mutate('skill', '/skills/' + encodeURIComponent(dataId(node.dataset.skillRemove)), {
          method: 'DELETE',
        }))
      )
        toast(tr('skillRemoved'));
    });
    click('[data-skill-import]', importEditor);
    click('[data-skill-import-source]', (node) => {
      const draft = importDraft;
      if (
        !draft ||
        draft.pending ||
        busy ||
        !online() ||
        (node.dataset.skillImportSource !== 'github' && node.dataset.skillImportSource !== 'file')
      )
        return;
      captureImport(document.querySelector<HTMLFormElement>('#skill-import-form'));
      if (draft.mode === node.dataset.skillImportSource) return;
      discardImportPreview(draft.preview, draft.scope);
      draft.mode = node.dataset.skillImportSource;
      draft.preview = null;
      draft.error = '';
      draft.unknown = false;
      draft.detailsOpen = false;
      render();
    });
    click('[data-skill-import-preview]', () =>
      previewImport(document.querySelector<HTMLFormElement>('#skill-import-form')),
    );
    click('[data-skill-import-refresh]', loadSkills);
    document.querySelectorAll<HTMLInputElement>('[data-skill-toggle]').forEach(
      (node) =>
        (node.onchange = () =>
          mutate('skill', '/skills/' + encodeURIComponent(dataId(node.dataset.skillToggle)), {
            method: 'PATCH',
            body: { enabled: node.checked },
          })),
    );
    const pathScope = scope();
    document.querySelectorAll<HTMLInputElement>('[data-skill-path]').forEach(
      (node) =>
        (node.ontoggle = () => {
          if (!node.isConnected || pathScope !== scope()) return;
          if (node.hasAttribute('open')) expandedSkillPaths.add(dataId(node.dataset.skillPath));
          else expandedSkillPaths.delete(dataId(node.dataset.skillPath));
        }),
    );
    const credentialForm = document.querySelector<HTMLFormElement>('#credential-form');
    if (credentialForm) {
      credentialForm.oninput = () => captureCredential(credentialForm);
      credentialForm.onsubmit = (event) => {
        event.preventDefault();
        return saveCredential(credentialForm);
      };
    }
    const skillForm = document.querySelector<HTMLFormElement>('#skill-form');
    if (skillForm) {
      skillForm.oninput = () => captureSkill(skillForm);
      skillForm.onsubmit = (event) => {
        event.preventDefault();
        return saveSkill(skillForm);
      };
    }
    const importForm = document.querySelector<HTMLFormElement>('#skill-import-form');
    if (importForm) {
      const draft = importDraft;
      importForm.oninput = () => {
        const previous = draft?.preview;
        captureImport(importForm);
        if (previous !== draft?.preview) render();
      };
      importForm.onchange = () => captureImport(importForm);
      importForm.onsubmit = (event) => {
        event.preventDefault();
        return draft?.preview ? commitImport(importForm) : previewImport(importForm);
      };
      const file = field(importForm, 'file');
      if (file)
        file.onchange = () => {
          if (!draft || importDraft !== draft || draft.pending) return;
          discardImportPreview(draft.preview, draft.scope);
          draft.file = file.files?.[0] || null;
          draft.preview = null;
          draft.unknown = false;
          draft.error = (draft.file?.size ?? 0) > SKILL_ARCHIVE_BYTES ? 'skillImportLimit' : '';
          draft.detailsOpen = false;
          render();
        };
      const details = document.querySelector<HTMLInputElement>('#skill-import-instructions');
      if (details)
        details.ontoggle = () => {
          if (draft && importDraft === draft && details.isConnected && draft.scope === scope())
            draft.detailsOpen = details.hasAttribute('open');
        };
    }
    const search = document.querySelector<HTMLInputElement>('#skills-search');
    if (search)
      search.oninput = () => {
        skillSearch = search.value.slice(0, 200);
        render();
      };
  }
  return {
    renderCredentials,
    renderSkills,
    renderSkillPage,
    renderRequests,
    renderModal,
    syncModal,
    onClose,
    clearSecret,
    load,
    loadSkills,
    bind,
  };
}
