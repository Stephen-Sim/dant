const validId=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\x00-\x20\x7f]/.test(value);
export function taskPlanBindingFeedback(activeWorkId){
 if(!validId(activeWorkId))throw Error('The task progress binding is invalid.');
 return {saved:false,code:'work_conflict',activeWorkId,guidance:`This automatic continuation is bound to workId ${activeWorkId}. The requested plan was not saved. Retry task_plan with this exact workId and only this task's actual title and steps. Do not switch to, overwrite or start unrelated work in this turn.`};
}
export class TaskPlanBindingConflict extends Error{
 constructor(activeWorkId){
  const feedback=taskPlanBindingFeedback(activeWorkId);
  super(`Automatic continuation must keep its exact registered workId: ${activeWorkId}. ${feedback.guidance}`);
  this.name='TaskPlanBindingConflict';this.code=feedback.code;this.activeWorkId=activeWorkId;
 }
}
