/** Protocol and persistence bounds shared by work validation and progress. */
export const WorkLimits = Object.freeze({
  MaxTimestamp: 8_640_000_000_000_000,
  IdLength: 128,
  ReferenceIdLength: 256,
  RuntimeIdLength: 512,
  PlanSteps: 128,
  PlanTitleLength: 240,
  PlanInputStepLength: 5_000,
  PublicStepLength: 240,
  ObservedItems: 128,
} as const);

/** Automatic continuation timing never changes an uncertain action into a retry. */
export const ContinuationPolicy = Object.freeze({
  InitialDelayMs: 5_000,
  BaseDelayMs: 30_000,
  MaxDelayMs: 300_000,
  MaxBackoffExponent: 4,
  NoProgressLimit: 3,
} as const);
