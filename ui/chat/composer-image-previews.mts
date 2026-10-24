import type { Attachment, UiModal } from '../shared/contracts.mts';
import { escapeHtml as esc } from '../shared/html.mts';
import { translate } from '../i18n/messages.mts';

export function renderComposerImage(
  file: Attachment,
  { language, fileURL }: { language: string; fileURL: (file: Attachment) => string },
): string {
  const preview = translate(language, 'Preview image', '预览图片') + ' ' + file.name,
    remove = translate(language, 'Remove image', '移除图片') + ' ' + file.name;
  return `<div class="draft-image" data-key="draft-image-${esc(file.id)}" data-id="${esc(file.id)}"><button type="button" class="image-attachment draft-image-preview" data-draft-preview="${esc(file.id)}" data-image-state="loading" aria-busy="true" aria-label="${esc(preview)}" title="${esc(preview)}"><img class="attachment-image" src="${esc(fileURL(file))}" alt="${esc(file.name)}" decoding="async"><span class="attachment-image-loading" aria-hidden="true">${translate(language, 'Loading image…', '正在加载图片…')}</span><span class="attachment-image-error" role="status">${translate(language, 'Image unavailable', '图片暂不可用')}</span></button><button type="button" class="draft-image-remove" data-remove="${esc(file.id)}" aria-label="${esc(remove)}" title="${esc(remove)}">×</button><span class="draft-image-name" title="${esc(file.name)}">${esc(file.name)}</span></div>`;
}

export function createComposerImagePreviews({
  getAttachments,
  getScope,
  openModal,
  remove,
}: {
  getAttachments: () => readonly Attachment[];
  getScope: () => string;
  openModal: (modal: UiModal) => void;
  remove: (file: Attachment) => void;
}) {
  const owners = new WeakMap<UiModal, { file: Attachment; scope: string }>();
  function current(file: Attachment, scope: string): boolean {
    return (
      scope === getScope() && getAttachments().includes(file) && file.type.startsWith('image/')
    );
  }
  function file(modal: UiModal): Attachment | null | undefined {
    const owner = owners.get(modal);
    if (!owner) return undefined;
    return current(owner.file, owner.scope) ? owner.file : null;
  }
  return {
    file,
    syncModal(modal: UiModal | null): UiModal | null {
      while (modal && file(modal) === null) modal = modal.parent ?? null;
      return modal;
    },
    resolveDownload(
      modal: UiModal | null,
      fallback: (id: string) => Attachment | null | undefined,
    ): (id: string | undefined) => Attachment | null | undefined {
      return (id) => {
        if (!id) return undefined;
        const draft = modal?.fileId === id ? file(modal) : undefined;
        return draft === undefined ? fallback(id) : draft;
      };
    },
    bind(root: ParentNode & Pick<Node, 'contains'>): void {
      const scope = getScope();
      for (const button of root.querySelectorAll<HTMLButtonElement>(
        '[data-draft-preview],.draft-image-remove',
      )) {
        const id = button.dataset.draftPreview ?? button.dataset.remove,
          attachment = getAttachments().find((item) => item.id === id);
        button.onclick = () => {
          if (!root.contains(button) || !attachment || !current(attachment, scope)) return;
          if (button.classList.contains('draft-image-remove')) remove(attachment);
          else {
            const modal: UiModal = { type: 'image', fileId: attachment.id };
            owners.set(modal, { file: attachment, scope });
            openModal(modal);
          }
        };
      }
    },
  };
}
