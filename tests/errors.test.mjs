import test from 'node:test';
import assert from 'node:assert/strict';
import {readableError} from '../src/errors.mjs';
test('account model errors are presented as readable text without JSON wrappers',()=>{
 const message="The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
 assert.equal(readableError(JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message}})),message);
 assert.equal(readableError('VM disconnected'),'VM disconnected');
 assert.equal(readableError(undefined),undefined);
});
