// SPDX-License-Identifier: Apache-2.0
// The domain layer's public surface. Everything a layer above may use is named here, and
// nothing else is. The layer is pure: no filesystem, no clock, no randomness, no process.
// Instants, ids and derived facts arrive as arguments. docs/DOMAIN.md is the doc side of
// this file, and test/architecture/layering.test.ts is the enforcement.

export {
  DOMAIN_ERROR_CODES,
  fail,
  ok,
  type DomainError,
  type DomainErrorCode,
  type Failure,
  type Result,
  type Success,
} from './errors.ts'

export {
  ATTEMPT_OUTCOMES,
  BUG_SEVERITIES,
  DEFAULT_POINT_SCALE,
  EVIDENCE_KINDS,
  FOUND_IN_STAGES,
  GUARD_IDS,
  RELATION_KINDS,
  RESOLUTIONS,
  TERMINAL_STATES,
  TRANSITIONS,
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
  isTerminal,
  type AcceptanceCriterion,
  type AttemptOutcome,
  type BugSeverity,
  type EvidenceKind,
  type EvidencePointer,
  type FoundInStage,
  type GuardId,
  type Instant,
  type ItemId,
  type RelationKind,
  type Resolution,
  type TransitionName,
  type WorkItem,
  type WorkItemState,
  type WorkItemType,
} from './types.ts'

export {
  MAX_OVERDUE_DAYS,
  daysOverdue,
  healthFindings,
  isOverdue,
  type HealthFinding,
} from './dates.ts'

export {
  FIELD_KEY_PATTERN,
  FORBIDDEN_FIELD_KEYS,
  buildRecord,
  isForbiddenFieldKey,
  validateFieldKeys,
} from './record.ts'

export {
  findUnsafeCharacter,
  isSafeText,
  type TextMode,
  type UnsafeCharacter,
} from './text.ts'

export {
  COMMON_FIELDS,
  MAX_DESCRIPTION,
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_LABEL,
  MAX_EVIDENCE_REF,
  MAX_REASON,
  fieldsOf,
  isInstant,
  isKnownField,
  overLength,
  requiredAtCreation,
  validateWorkItem,
  type ValidateOptions,
} from './fields.ts'

export {
  DEFAULT_DONE_GATE,
  DEFAULT_READY_GATE,
  evaluateGate,
  validateGate,
  type Gate,
  type GateCheck,
  type GateChild,
  type GateContext,
  type GateRule,
  type GateRuleVerdict,
  type GateVerdict,
} from './gates.ts'

export {
  OVERRIDABLE_GUARDS,
  TRANSITION_TABLE,
  evaluateTransition,
  legalTargetsFrom,
  type GuardResult,
  type TransitionContext,
  type TransitionOutcome,
  type TransitionRequest,
} from './state-machine.ts'

export {
  ALLOWED_PARENT_PAIRS,
  MAX_HIERARCHY_DEPTH,
  childrenOf,
  cycleAbove,
  findHierarchyCycle,
  findParentCycle,
  hierarchyFrom,
  rollUp,
  setParent,
  type HierarchyGraph,
  type RollUp,
} from './hierarchy.ts'

export {
  MAX_RELATION_DEPTH,
  addRelation,
  blockersOf,
  emptyRelationGraph,
  findRelationCycle,
  inverseOf,
  isBlocked,
  isSymmetric,
  relationsOf,
  removeRelation,
  type Relation,
  type RelationGraph,
  type RelationView,
} from './relations.ts'
