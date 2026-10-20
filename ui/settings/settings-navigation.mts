import { escapeHtml as escape } from '../shared/html.mts';
import { localizeMessages, translate } from '../i18n/messages.mts';
import { callCaptionCopy } from '../call/call-caption-copy.mts';
const categories = [
  ['general', 'General', '通用'],
  ['appearance', 'Appearance', '外观'],
  ['voice', 'Voice', '语音'],
  ['computer', 'Work computer', '工作电脑'],
  ['account', 'ChatGPT', 'ChatGPT 账号'],
  ['usage', 'Usage', '用量统计'],
  ['credentials', 'Credentials', '凭据与密钥'],
  ['history', 'Chat & data', '聊天与数据'],
  ['telegram', 'Telegram', 'Telegram 集成'],
  ['about', 'About dant', '关于 dant'],
] as const;
export type SettingsCategory = (typeof categories)[number][0];
// Search this fixed catalogue only. Never read rendered form values, credential
// metadata, account details, conversation text, or any other user data.
const entries: readonly (readonly [string, SettingsCategory, string, string, string, string])[] = [
  ['language', 'general', 'Language', '语言', 'English Chinese 中文 英文', '[data-language]'],
  [
    'notifications',
    'general',
    'Message notifications',
    '消息通知',
    'notify alert 提醒',
    '#notifications',
  ],
  [
    'work-summary',
    'general',
    'Show work progress in chat',
    '在聊天中显示任务进度',
    'task work summary progress card show hide 任务 工作 进度 摘要 卡片 显示 隐藏',
    '#showWorkSummary',
  ],
  [
    'text-editor',
    'general',
    'Open with',
    '打开方式',
    'Default text editor VS Code Notepad Sublime source code open 默认文本编辑器 编辑器 记事本 源码 打开',
    '.text-editor-settings',
  ],
  [
    'mode',
    'appearance',
    'Light, dark or system mode',
    '浅色、深色或跟随系统',
    'theme light dark 主题 模式',
    '[data-theme]',
  ],
  [
    'theme',
    'appearance',
    'Theme preset',
    '主题预设',
    'visual style 视觉 风格',
    '#appearance-preset',
  ],
  ['accent', 'appearance', 'Accent color', '强调色', 'color 颜色', '#appearance-accentColor'],
  [
    'background',
    'appearance',
    'Background color',
    '背景颜色',
    'color 颜色',
    '#appearance-backgroundColor',
  ],
  [
    'foreground',
    'appearance',
    'Foreground color',
    '文字颜色',
    'color text 字色 前景',
    '#appearance-foregroundColor',
  ],
  ['font', 'appearance', 'Font', '字体', 'typeface family 字形', '#appearance-font-picker>summary'],
  ['ui-size', 'appearance', 'UI font size', '界面字号', 'size text 文字大小', '#appearance-size'],
  [
    'content-size',
    'appearance',
    'Content font size',
    '内容字号',
    'size chat 文字大小',
    '#appearance-content-size',
  ],
  [
    'code-size',
    'appearance',
    'Code font size',
    '代码字号',
    'size text 文字大小',
    '#appearance-code-size',
  ],
  ['motion', 'appearance', 'Reduce motion', '减少动态效果', 'animation 动画', '#appearance-motion'],
  ['call-voice', 'voice', 'Call voice', '通话声音', 'subscription ChatGPT 订阅', '#nativeVoice'],
  [
    'call-captions',
    'voice',
    'Live captions',
    '实时字幕',
    'captions subtitles transcript voice call 转写 字幕 通话',
    '#showCallCaptions',
  ],
  [
    'voice-key',
    'voice',
    'Optional voice API key',
    '可选语音 API 密钥',
    'key secret realtime 独立计费',
    '#voice-api-key',
  ],
  ['api-voice', 'voice', 'Separate API voice', '独立 API 声音', 'voice call 通话', '#apiVoice'],
  [
    'connection',
    'computer',
    'Connect an existing VM',
    '连接已有虚拟机',
    'reconnect host SSH Hyper-V VMware 工作电脑 重连 IP',
    '.vm-settings',
  ],
  [
    'setup',
    'computer',
    'Create work computer',
    '创建工作电脑',
    'Ubuntu VM cpu memory disk 虚拟机 资源 处理器 内存 磁盘',
    '.vm-settings',
  ],
  [
    'permissions',
    'computer',
    'Administration permissions',
    '管理权限',
    'sudo admin 管理员 权限',
    '[data-setting-card="permissions"]',
  ],
  [
    'subscription',
    'account',
    'ChatGPT sign-in & subscription',
    'ChatGPT 登录与订阅',
    'account login logout 账号 退出',
    '[data-setting-card="account"]',
  ],
  ['model', 'account', 'Model', '模型', 'ChatGPT account 账号', '#model'],
  [
    'usage',
    'usage',
    'Token usage',
    'Token 用量统计',
    'tokens input cached output reasoning statistics 输入 缓存 输出 推理 消耗 统计',
    '[data-setting-card="usage"]',
  ],
  [
    'vault',
    'credentials',
    'Credential vault',
    '凭据与密钥管理',
    'password login secret key 密码 登录 凭据 保存',
    '.credentials-settings',
  ],
  [
    'clear-history',
    'history',
    'Clear chat history',
    '清空聊天记录',
    'delete remove data 删除 对话 数据',
    '.conversation-settings',
  ],
  [
    'backups',
    'history',
    'Work computer backups',
    '工作电脑备份',
    'backup restore export portable memory skills schedules data 备份 恢复 导出 便携 记忆 技能 定时 数据',
    '.vm-backups',
  ],
  [
    'backup-import',
    'computer',
    'Import backup file',
    '导入备份文件',
    'import dant portable backup file 导入 dant 便携 备份 文件',
    '.vm-backup-import',
  ],
  ['memory', 'history', 'Memory', '记忆', 'reference 笔记', '[data-action="memory"]'],
  [
    'schedules',
    'history',
    'Scheduled tasks',
    '提醒与定时任务',
    'reminder schedule 提醒 定时',
    '[data-action="schedules"]',
  ],
  [
    'telegram-token',
    'telegram',
    'Telegram bot token',
    'Telegram 机器人令牌',
    'integration token key 集成 消息 接入',
    '#telegram-token',
  ],
  [
    'telegram-pair',
    'telegram',
    'Pair Telegram account',
    '绑定 Telegram 账号',
    'bot connection chat messages 配对 集成 消息',
    '.telegram-settings',
  ],
  [
    'version',
    'about',
    'App version',
    '应用版本',
    'version release 版本号 发布',
    '[data-app-version]',
  ],
  [
    'updates',
    'about',
    'Check for updates',
    '检查更新',
    'download release upgrade 下载 升级',
    '[data-check-updates]',
  ],
];
const words = {
  en: {
    menu: 'Settings categories',
    search: 'Search settings',
    clear: 'Clear search',
    results: 'Search results',
    none: 'No matching settings.',
  },
  zh: {
    menu: '设置分类',
    search: '搜索设置',
    clear: '清空搜索',
    results: '搜索结果',
    none: '没有找到匹配的设置。',
  },
};
const normalized = (value: unknown) => String(value).normalize('NFKC').toLocaleLowerCase().trim();

export function createSettingsNavigation({
  document = globalThis.document,
  getLanguage = () => 'en',
  onChange = () => {},
  onCategory = () => {},
  onError = () => {},
}: {
  document?: Document;
  getLanguage?: () => unknown;
  onChange?: () => void;
  onCategory?: (category: SettingsCategory) => unknown;
  onError?: (error: unknown) => void;
} = {}) {
  let category: SettingsCategory = 'general',
    query = '',
    visible = false,
    generation = 0,
    pendingFocus: { category: SettingsCategory; selector: string } | null = null;
  const language = () => getLanguage(),
    label = (item: readonly [string, string, string] | undefined) =>
      item ? translate(language(), item[1], item[2]) : '',
    tr = () => localizeMessages(words, language()),
    entryLabel = (entry: (typeof entries)[number]) =>
      entry[0] === 'call-captions'
        ? callCaptionCopy(language()).title
        : translate(language(), entry[2], entry[3]);
  const matches = () => {
    const terms = normalized(query).split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
      const group = categories.find((item) => item[0] === entry[1]),
        search = normalized(
          [...entry.slice(2, 5), ...(group?.slice(1) ?? []), label(group), entryLabel(entry)].join(
            ' ',
          ),
        );
      return terms.every((term) => search.includes(term));
    });
  };
  function load() {
    const run = generation,
      selected = category;
    void Promise.resolve()
      .then(() => {
        if (visible && run === generation && selected === category) return onCategory(selected);
      })
      .catch((error) => {
        if (visible && run === generation && selected === category) onError(error);
      });
  }
  function sync(value: unknown) {
    value = Boolean(value);
    if (value === visible) return;
    visible = Boolean(value);
    generation++;
    if (visible) load();
    else pendingFocus = null;
  }
  function select(next: unknown, selector?: string) {
    const chosen = categories.find((item) => item[0] === next);
    if (!chosen) return false;
    const changed = next !== category,
      wasVisible = visible;
    if (changed) generation++;
    category = chosen[0];
    query = '';
    pendingFocus = selector ? { category, selector } : null;
    onChange();
    if (wasVisible && changed) load();
    return true;
  }
  function render(sections: Partial<Record<SettingsCategory, string>>) {
    const text = tr(),
      searching = Boolean(query.trim()),
      results = searching ? matches() : [];
    return `<div class="settings-layout" data-key="settings-layout"><aside class="settings-sidebar"><div class="settings-search-box"><label for="settings-search">${text.search}</label><div><input type="search" id="settings-search" placeholder="${text.search}" value="${escape(query)}" autocomplete="off">${query ? `<button type="button" data-settings-clear aria-label="${text.clear}" title="${text.clear}">×</button>` : ''}</div></div><nav class="settings-category-nav" aria-label="${text.menu}">${categories.map((item) => `<button type="button" data-settings-category="${item[0]}" ${!searching && item[0] === category ? 'aria-current="page"' : ''}>${label(item)}</button>`).join('')}</nav></aside><div class="settings-category-content"><section class="settings-search-results" ${searching ? '' : 'hidden'} aria-labelledby="settings-results-title"><h2 id="settings-results-title">${text.results}</h2><div aria-live="polite" aria-relevant="additions text">${results.map((entry) => `<button type="button" class="settings-search-result" data-settings-result="${entry[0]}"><small>${label(categories.find((item) => item[0] === entry[1]))}</small><strong>${entryLabel(entry)}</strong></button>`).join('')}${searching && !results.length ? `<p class="settings-search-empty">${text.none}</p>` : ''}</div></section><div class="settings-category-panels">${categories.map((item) => `<div class="settings-category-panel" id="settings-${item[0]}" data-settings-panel="${item[0]}" data-key="settings-panel-${item[0]}" ${!searching && category === item[0] ? '' : 'hidden'}>${sections[item[0]] || ''}</div>`).join('')}</div></div></div>`;
  }
  function focusTarget() {
    if (!pendingFocus || !visible) return;
    const target = pendingFocus;
    pendingFocus = null;
    if (target.category !== category) return;
    const panel = document.querySelector<HTMLElement>(`[data-settings-panel="${category}"]`);
    let node;
    try {
      node = panel?.querySelector<HTMLElement>(target.selector);
    } catch {}
    node ||= panel;
    if (!node) return;
    for (let parent = node.parentElement; parent && parent !== panel; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
    if ('disabled' in node && node.disabled === true)
      node = node.closest<HTMLElement>('.settings-section') || panel;
    if (!node) return;
    if (!node.matches('button,input,select,textarea,a[href],summary,[tabindex]'))
      node.setAttribute('tabindex', '-1');
    node.scrollIntoView?.({ block: 'center' });
    node.focus?.({ preventScroll: true });
  }
  function bind() {
    const input = document.querySelector<HTMLInputElement>('#settings-search');
    if (input) {
      input.oninput = () => {
        query = input.value.slice(0, 120);
        onChange();
      };
      input.onkeydown = (event) => {
        if (event.isComposing) return;
        if (event.key === 'Escape' && query) {
          event.preventDefault();
          event.stopPropagation();
          query = '';
          onChange();
          document.querySelector<HTMLInputElement>('#settings-search')?.focus();
        } else if (['Enter', 'ArrowDown'].includes(event.key) && query.trim()) {
          event.preventDefault();
          document.querySelector<HTMLElement>('[data-settings-result]')?.focus();
          if (event.key === 'Enter') {
            const first = matches()[0];
            if (first) select(first[1], first[5]);
          }
        }
      };
    }
    const clear = document.querySelector<HTMLElement>('[data-settings-clear]');
    if (clear)
      clear.onclick = () => {
        query = '';
        onChange();
        document.querySelector<HTMLInputElement>('#settings-search')?.focus();
      };
    document.querySelectorAll<HTMLButtonElement>('[data-settings-category]').forEach((button) => {
      button.onclick = () => select(button.dataset.settingsCategory);
      button.onkeydown = (event) => {
        const offsets: Readonly<Partial<Record<string, number>>> = {
          ArrowDown: 1,
          ArrowRight: 1,
          ArrowUp: -1,
          ArrowLeft: -1,
        };
        const offset = offsets[event.key];
        if (offset || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const index = categories.findIndex((item) => item[0] === button.dataset.settingsCategory),
            next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? categories.length - 1
                  : (index + (offset ?? 0) + categories.length) % categories.length;
          select(categories[next]![0]);
          document
            .querySelector<HTMLElement>(`[data-settings-category="${categories[next]![0]}"]`)
            ?.focus();
        }
      };
    });
    document.querySelectorAll<HTMLButtonElement>('[data-settings-result]').forEach(
      (button) =>
        (button.onclick = () => {
          const entry = entries.find((item) => item[0] === button.dataset.settingsResult);
          if (entry) select(entry[1], entry[5]);
        }),
    );
    focusTarget();
  }
  return {
    render,
    bind,
    sync,
    select,
    isVisible: (next: string) => visible && !query.trim() && category === next,
    get category() {
      return category;
    },
  };
}
