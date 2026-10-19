import { normalizeLanguage } from '../../src/i18n/languages.mts';
import type { LanguageCode } from '../../src/i18n/languages.mts';

interface CaptionCopy {
  title: string;
  label: string;
  hint: string;
  waiting: string;
  show: string;
  hide: string;
  failed: string;
}
const copy: Record<LanguageCode, CaptionCopy> = {
  en: {
    title: 'Live captions',
    label: 'dant live captions',
    hint: 'Show dant’s spoken replies. Text stays in the current call only.',
    waiting: 'Captions on · Waiting for dant’s spoken text…',
    show: 'Show captions',
    hide: 'Hide captions',
    failed: 'Caption preference could not be saved. Refresh settings before trying again.',
  },
  zh: {
    title: '实时字幕',
    label: 'dant 实时字幕',
    hint: '显示 dant 的语音回复文字，仅保留在当前通话中。',
    waiting: '字幕已开启 · 等待 dant 的语音文字…',
    show: '显示字幕',
    hide: '隐藏字幕',
    failed: '字幕偏好保存失败，请刷新设置后再试。',
  },
  'zh-TW': {
    title: '即時字幕',
    label: 'dant 即時字幕',
    hint: '顯示 dant 的語音回覆文字，僅保留於目前通話。',
    waiting: '字幕已開啟 · 等待 dant 的語音文字…',
    show: '顯示字幕',
    hide: '隱藏字幕',
    failed: '字幕偏好儲存失敗，請重新整理設定後再試。',
  },
  ja: {
    title: 'ライブ字幕',
    label: 'dant のライブ字幕',
    hint: 'dant の音声返信を表示します。テキストは現在の通話内にのみ保持されます。',
    waiting: '字幕オン · dant の音声テキストを待っています…',
    show: '字幕を表示',
    hide: '字幕を非表示',
    failed: '字幕設定を保存できませんでした。設定を更新してから再試行してください。',
  },
  ko: {
    title: '실시간 자막',
    label: 'dant 실시간 자막',
    hint: 'dant의 음성 답변을 표시합니다. 텍스트는 현재 통화에만 유지됩니다.',
    waiting: '자막 켜짐 · dant의 음성 텍스트를 기다리는 중…',
    show: '자막 표시',
    hide: '자막 숨기기',
    failed: '자막 설정을 저장하지 못했습니다. 설정을 새로 고친 후 다시 시도하세요.',
  },
  es: {
    title: 'Subtítulos en directo',
    label: 'Subtítulos en directo de dant',
    hint: 'Muestra las respuestas habladas de dant. El texto solo se conserva durante la llamada actual.',
    waiting: 'Subtítulos activados · Esperando el texto de voz de dant…',
    show: 'Mostrar subtítulos',
    hide: 'Ocultar subtítulos',
    failed:
      'No se pudo guardar la preferencia de subtítulos. Actualiza los ajustes antes de intentarlo de nuevo.',
  },
  fr: {
    title: 'Sous-titres en direct',
    label: 'Sous-titres en direct de dant',
    hint: 'Affiche les réponses vocales de dant. Le texte reste uniquement dans l’appel en cours.',
    waiting: 'Sous-titres activés · En attente du texte vocal de dant…',
    show: 'Afficher les sous-titres',
    hide: 'Masquer les sous-titres',
    failed:
      'Impossible d’enregistrer la préférence des sous-titres. Actualisez les paramètres avant de réessayer.',
  },
  de: {
    title: 'Live-Untertitel',
    label: 'Live-Untertitel von dant',
    hint: 'Zeigt die gesprochenen Antworten von dant. Der Text bleibt nur im aktuellen Anruf.',
    waiting: 'Untertitel an · Warten auf den gesprochenen Text von dant…',
    show: 'Untertitel anzeigen',
    hide: 'Untertitel ausblenden',
    failed:
      'Die Untertiteleinstellung konnte nicht gespeichert werden. Aktualisiere die Einstellungen und versuche es erneut.',
  },
  pt: {
    title: 'Legendas em direto',
    label: 'Legendas em direto de dant',
    hint: 'Mostra as respostas faladas de dant. O texto fica apenas na chamada atual.',
    waiting: 'Legendas ativadas · A aguardar o texto falado de dant…',
    show: 'Mostrar legendas',
    hide: 'Ocultar legendas',
    failed:
      'Não foi possível guardar a preferência de legendas. Atualize as definições antes de tentar novamente.',
  },
  ru: {
    title: 'Субтитры в реальном времени',
    label: 'Субтитры dant в реальном времени',
    hint: 'Показывать голосовые ответы dant. Текст хранится только в текущем звонке.',
    waiting: 'Субтитры включены · Ожидание текста речи dant…',
    show: 'Показать субтитры',
    hide: 'Скрыть субтитры',
    failed: 'Не удалось сохранить настройку субтитров. Обновите настройки и повторите попытку.',
  },
  ar: {
    title: 'ترجمة نصية مباشرة',
    label: 'الترجمة النصية المباشرة لـ dant',
    hint: 'اعرض ردود dant المنطوقة. يبقى النص في المكالمة الحالية فقط.',
    waiting: 'النص المباشر مفعّل · بانتظار نص كلام dant…',
    show: 'إظهار النص المباشر',
    hide: 'إخفاء النص المباشر',
    failed: 'تعذّر حفظ تفضيل النص المباشر. حدّث الإعدادات قبل المحاولة مجددًا.',
  },
  hi: {
    title: 'लाइव कैप्शन',
    label: 'dant के लाइव कैप्शन',
    hint: 'dant के बोले गए उत्तर दिखाएँ। टेक्स्ट केवल मौजूदा कॉल में रहता है।',
    waiting: 'कैप्शन चालू · dant के बोले गए टेक्स्ट की प्रतीक्षा…',
    show: 'कैप्शन दिखाएँ',
    hide: 'कैप्शन छिपाएँ',
    failed: 'कैप्शन की सेटिंग सेव नहीं हुई। दोबारा कोशिश करने से पहले सेटिंग रीफ़्रेश करें।',
  },
  id: {
    title: 'Teks langsung',
    label: 'Teks langsung dant',
    hint: 'Tampilkan jawaban lisan dant. Teks hanya disimpan selama panggilan saat ini.',
    waiting: 'Teks aktif · Menunggu teks ucapan dant…',
    show: 'Tampilkan teks',
    hide: 'Sembunyikan teks',
    failed: 'Preferensi teks tidak dapat disimpan. Segarkan pengaturan sebelum mencoba lagi.',
  },
  ms: {
    title: 'Sari kata langsung',
    label: 'Sari kata langsung dant',
    hint: 'Paparkan jawapan lisan dant. Teks kekal dalam panggilan semasa sahaja.',
    waiting: 'Sari kata aktif · Menunggu teks pertuturan dant…',
    show: 'Tunjukkan sari kata',
    hide: 'Sembunyikan sari kata',
    failed: 'Pilihan sari kata tidak dapat disimpan. Muat semula tetapan sebelum mencuba lagi.',
  },
  it: {
    title: 'Sottotitoli dal vivo',
    label: 'Sottotitoli dal vivo di dant',
    hint: 'Mostra le risposte vocali di dant. Il testo resta solo nella chiamata corrente.',
    waiting: 'Sottotitoli attivi · In attesa del testo vocale di dant…',
    show: 'Mostra sottotitoli',
    hide: 'Nascondi sottotitoli',
    failed:
      'Impossibile salvare la preferenza dei sottotitoli. Aggiorna le impostazioni prima di riprovare.',
  },
  tr: {
    title: 'Canlı altyazılar',
    label: 'dant canlı altyazıları',
    hint: 'dant’ın sesli yanıtlarını gösterir. Metin yalnızca geçerli aramada tutulur.',
    waiting: 'Altyazılar açık · dant’ın konuşma metni bekleniyor…',
    show: 'Altyazıları göster',
    hide: 'Altyazıları gizle',
    failed: 'Altyazı tercihi kaydedilemedi. Yeniden denemeden önce ayarları yenileyin.',
  },
};
const disabled: Record<LanguageCode, string> = {
  en: 'Captions off',
  zh: '字幕已关闭',
  'zh-TW': '字幕已關閉',
  ja: '字幕オフ',
  ko: '자막 꺼짐',
  es: 'Subtítulos desactivados',
  fr: 'Sous-titres désactivés',
  de: 'Untertitel aus',
  pt: 'Legendas desativadas',
  ru: 'Субтитры выключены',
  ar: 'النص المباشر متوقف',
  hi: 'कैप्शन बंद',
  id: 'Teks nonaktif',
  ms: 'Sari kata dimatikan',
  it: 'Sottotitoli disattivati',
  tr: 'Altyazılar kapalı',
};
export const callCaptionCopy = (language: unknown): CaptionCopy & { disabled: string } => {
  const code = normalizeLanguage(language);
  return { ...copy[code], disabled: disabled[code] };
};
