import { localizeMessages, translate } from '../../src/i18n/i18n.mts';
import { languageInfo, normalizeLanguage } from '../../src/i18n/languages.mts';
import { isRecord, isSafeInteger, isFiniteNumber } from '../shared/contracts.mts';
const reasons = {
  zh: {
    timeout: '请求超时',
    network: '网络连接中断',
    dns: '无法解析 Telegram 地址',
    tls: '安全连接失败',
    cancelled: '请求已取消',
    'invalid-response': '返回内容无效',
    'response-too-large': '返回内容超过限制',
    server: 'Telegram 服务暂时出错',
    rejected: 'Telegram 拒绝了这次发送',
    attachment: '附件读取或发送失败',
    unconfirmed: '未收到发送确认',
  },
  en: {
    timeout: 'Request timed out',
    network: 'Network connection interrupted',
    dns: 'Telegram address could not be resolved',
    tls: 'Secure connection failed',
    cancelled: 'Request cancelled',
    'invalid-response': 'Invalid response',
    'response-too-large': 'Response exceeded the size limit',
    server: 'Telegram service error',
    rejected: 'Telegram rejected this delivery',
    attachment: 'Attachment could not be read or sent',
    unconfirmed: 'Delivery acknowledgement was not received',
  },
};
const count = (value: unknown) => (isSafeInteger(value) && value > 0 ? value : 0);
export function telegramConnectionError(value: unknown = {}) {
  const status = isRecord(value) ? value : {};
  const error = Object.hasOwn(status, 'connectionError')
    ? status.connectionError
    : status.connected
      ? null
      : status.lastError;
  return typeof error === 'string' && error.trim() ? error : null;
}

export function telegramDeliveryNotice(
  value: unknown = {},
  {
    language = 'en',
    online = true,
    formatTime,
  }: { language?: unknown; online?: boolean; formatTime?: (time: number) => string } = {},
) {
  const status = isRecord(value) ? value : {},
    delivery = isRecord(status.delivery) ? status.delivery : {};
  const selected = normalizeLanguage(language, 'en'),
    info = languageInfo(selected),
    dictionary = localizeMessages(reasons, selected),
    unknown = count(delivery.unknown),
    failed = count(delivery.failed),
    parts = [];
  const tr = (english: string, chinese: string) => translate(selected, english, chinese),
    number = (value: number) => new Intl.NumberFormat(info.locale).format(value);
  const counted = (english: string, chinese: string, value: number) =>
    tr(english, chinese).replace('{count}', number(value));
  if (unknown)
    parts.push(
      counted(
        unknown === 1
          ? '{count} message with unconfirmed delivery'
          : '{count} messages with unconfirmed delivery',
        '{count} 条消息的发送结果未确认',
        unknown,
      ),
    );
  if (failed)
    parts.push(
      counted(
        failed === 1 ? '{count} message was not delivered' : '{count} messages were not delivered',
        '{count} 条消息未送达',
        failed,
      ),
    );
  if (!parts.length) return null;
  const issue = isRecord(delivery.lastIssue) ? delivery.lastIssue : null,
    valid =
      issue &&
      (issue.status === 'unknown' || issue.status === 'failed') &&
      (issue.status === 'unknown' ? unknown : failed) > 0;
  let latest = '';
  if (valid) {
    const details = [
      issue.status === 'unknown'
        ? tr('Last unconfirmed delivery', '最近一次未确认发送')
        : tr('Last failed delivery', '最近一次发送失败'),
    ];
    if (isFiniteNumber(issue.at) && issue.at > 0 && issue.at <= 8640000000000000) {
      try {
        const time =
          typeof formatTime === 'function'
            ? formatTime(issue.at)
            : new Intl.DateTimeFormat(info.locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(issue.at));
        if (typeof time === 'string' && time) details.push(time);
      } catch {}
    }
    details.push(
      typeof issue.reason === 'string' && Object.hasOwn(dictionary, issue.reason)
        ? dictionary[issue.reason as keyof typeof dictionary]
        : tr('Reason unavailable', '原因尚未确认'),
    );
    latest = details.join(' · ');
  }
  const ready =
    online &&
    status.enabled === true &&
    status.configured === true &&
    status.connected === true &&
    status.paired === true &&
    !telegramConnectionError(status);
  return {
    summary: parts.join(' · '),
    latest,
    reassurance: ready
      ? tr(
          'The Telegram connection and account pairing are still active. New messages can still be sent.',
          'Telegram 连接和账号配对仍然有效，新消息可以继续发送。',
        )
      : '',
    hint: unknown
      ? tr(
          'Check Telegram to see whether these messages arrived before sending again, to avoid duplicates. They will not be resent automatically.',
          '请先检查 Telegram 中是否已收到这些消息，避免重复发送。这些消息不会自动重发。',
        )
      : tr(
          'These earlier messages were not delivered and will not be resent automatically.',
          '这些历史消息未送达，不会自动重发。',
        ),
  };
}
