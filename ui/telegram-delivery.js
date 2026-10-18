const reasons={
 zh:{timeout:'请求超时',network:'网络连接中断',dns:'无法解析 Telegram 地址',tls:'安全连接失败',cancelled:'请求已取消','invalid-response':'返回内容无效','response-too-large':'返回内容超过限制',server:'Telegram 服务暂时出错',rejected:'Telegram 拒绝了这次发送',attachment:'附件读取或发送失败',unconfirmed:'未收到发送确认'},
 en:{timeout:'Request timed out',network:'Network connection interrupted',dns:'Telegram address could not be resolved',tls:'Secure connection failed',cancelled:'Request cancelled','invalid-response':'Invalid response','response-too-large':'Response exceeded the size limit',server:'Telegram service error',rejected:'Telegram rejected this delivery',attachment:'Attachment could not be read or sent',unconfirmed:'Delivery acknowledgement was not received'}
};
const count=value=>Number.isSafeInteger(value)&&value>0?value:0;
export function telegramConnectionError(status={}){
 status=status&&typeof status==='object'?status:{};
 const error=Object.hasOwn(status,'connectionError')?status.connectionError:status.connected?null:status.lastError;
 return typeof error==='string'&&error.trim()?error:null;
}

export function telegramDeliveryNotice(status={}, {language='en',online=true,formatTime=value=>new Date(value).toISOString()}={}){
 status=status&&typeof status==='object'?status:{};
 const zh=language!=='en',dictionary=reasons[zh?'zh':'en'],unknown=count(status.delivery?.unknown),failed=count(status.delivery?.failed),parts=[];
 if(unknown)parts.push(zh?`${unknown} 条消息的发送结果未确认`:`${unknown} message${unknown===1?'':'s'} with unconfirmed delivery`);
 if(failed)parts.push(zh?`${failed} 条消息未送达`:`${failed} message${failed===1?' was':'s were'} not delivered`);
 if(!parts.length)return null;
 const issue=status.delivery?.lastIssue,valid=issue&&['unknown','failed'].includes(issue.status)&&(issue.status==='unknown'?unknown:failed)>0;
 let latest='';
 if(valid){
  const details=[zh?issue.status==='unknown'?'最近一次未确认发送':'最近一次发送失败':issue.status==='unknown'?'Last unconfirmed delivery':'Last failed delivery'];
  if(Number.isFinite(issue.at)&&issue.at>0&&issue.at<=8640000000000000){try{const time=formatTime(issue.at);if(typeof time==='string'&&time)details.push(time);}catch{}}
  details.push(Object.hasOwn(dictionary,issue.reason)?dictionary[issue.reason]:zh?'原因尚未确认':'Reason unavailable');latest=details.join(' · ');
 }
 const ready=online&&status.enabled===true&&status.configured===true&&status.connected===true&&status.paired===true&&!telegramConnectionError(status);
 return {summary:parts.join(' · '),latest,reassurance:ready?zh?'Telegram 连接和账号配对仍然有效，新消息可以继续发送。':'The Telegram connection and account pairing are still active. New messages can still be sent.':'',hint:unknown?zh?'请先检查 Telegram 中是否已收到这些消息，避免重复发送。这些消息不会自动重发。':'Check Telegram to see whether these messages arrived before sending again, to avoid duplicates. They will not be resent automatically.':zh?'这些历史消息未送达，不会自动重发。':'These earlier messages were not delivered and will not be resent automatically.'};
}
