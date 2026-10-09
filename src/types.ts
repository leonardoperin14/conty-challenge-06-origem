export const ATTRIBUTION_WINDOW_HOURS = 168;
export const ATTRIBUTION_WINDOW_MS = ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000;
export const ATTRIBUTION_POLICY = {
  name: 'LAST_VALID_TOUCH',
  window_hours: ATTRIBUTION_WINDOW_HOURS,
  window_start: 'FIRST_OPEN',
  tie_break: 'LATEST_PERSISTED_SEQUENCE',
} as const;

export const SOURCES = ['campaign', 'referral', 'community'] as const;
export type Source = (typeof SOURCES)[number];
export type AttributionType = Source | 'organic';

export interface TouchForDecision {
  touch_token: string;
  source: Source;
  reference_id: string;
  recorded_at: string;
  sequence: number;
}

export type TouchReason =
  | 'LAST_VALID_TOUCH'
  | 'LATEST_SEQUENCE_ON_TIMESTAMP_TIE'
  | 'SUPERSEDED_BY_LATER_TOUCH'
  | 'TIE_LOST_TO_LATER_SEQUENCE'
  | 'OUTSIDE_WINDOW'
  | 'SIGNUP_AFTER_WINDOW'
  | 'AFTER_SIGNUP';

export interface AuditedTouch extends TouchForDecision {
  eligible: boolean;
  selected: boolean;
  reasons: TouchReason[];
}

export interface AttributionDecision {
  attribution_type: AttributionType;
  selected_touch_token: string | null;
  reason: 'LAST_VALID_TOUCH' | 'LATEST_SEQUENCE_ON_TIMESTAMP_TIE' | 'NO_VALID_TOUCH' | 'SIGNUP_AFTER_WINDOW';
  touches: AuditedTouch[];
}

export interface SignupDecisionRecord {
  signup_id: string;
  installation_id: string;
  signup_at: string;
  signup_sequence: number;
  window: {
    started_at: string;
    ends_at: string;
    duration_hours: number;
  };
  policy: typeof ATTRIBUTION_POLICY;
  attribution_type: AttributionType;
  selected_touch_token: string | null;
  reason: AttributionDecision['reason'];
  touches: AuditedTouch[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
