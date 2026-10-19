import { WorkerServiceFixture } from './service-fixtures.mts';
import type { RpcParams } from '../../src/runtime/protocol.ts';

export interface WorkerCall {
  method: string;
  params: RpcParams;
}

/** Call storage shared by isolated workers whose request behavior is configured by each test. */
export class TracingWorkerFixture extends WorkerServiceFixture {
  calls: WorkerCall[] = [];
}
