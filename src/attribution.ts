import {
  ATTRIBUTION_POLICY,
  ATTRIBUTION_WINDOW_MS,
  type AttributionDecision,
  type TouchReason,
  type TouchForDecision,
} from './types.ts';

export function resolveAttribution(input: {
  first_open_at: string;
  signup_at: string;
  touches: TouchForDecision[];
}): AttributionDecision {
  const firstOpenMs = Date.parse(input.first_open_at);
  const signupMs = Date.parse(input.signup_at);
  const windowEndMs = firstOpenMs + ATTRIBUTION_WINDOW_MS;
  const signupExpired = signupMs > windowEndMs;

  const evaluated = input.touches.map((touch) => {
    const touchedAt = Date.parse(touch.recorded_at);
    const reasons: Array<'OUTSIDE_WINDOW' | 'SIGNUP_AFTER_WINDOW' | 'AFTER_SIGNUP'> = [];
    if (touchedAt < firstOpenMs || touchedAt > windowEndMs) reasons.push('OUTSIDE_WINDOW');
    if (signupExpired) reasons.push('SIGNUP_AFTER_WINDOW');
    if (touchedAt > signupMs) reasons.push('AFTER_SIGNUP');
    const eligible = reasons.length === 0;
    return { ...touch, eligible, selected: false, reasons };
  });

  const eligible = signupExpired
    ? []
    : evaluated.filter((touch) => touch.eligible);
  eligible.sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at) || b.sequence - a.sequence);
  const winner = eligible[0];
  const tiedForLatest = winner
    ? eligible.filter((touch) => touch.recorded_at === winner.recorded_at)
    : [];

  if (!winner) {
    return {
      attribution_type: 'organic',
      selected_touch_token: null,
      reason: signupExpired ? 'SIGNUP_AFTER_WINDOW' : 'NO_VALID_TOUCH',
      touches: evaluated.map((touch) => {
        const reasons: TouchReason[] = touch.reasons.length
          ? touch.reasons
          : [signupExpired ? 'SIGNUP_AFTER_WINDOW' : 'OUTSIDE_WINDOW'];
        return { ...touch, reasons };
      }),
    };
  }

  const hasTie = tiedForLatest.length > 1;
  const decisionReason: 'LAST_VALID_TOUCH' | 'LATEST_SEQUENCE_ON_TIMESTAMP_TIE' =
    hasTie ? 'LATEST_SEQUENCE_ON_TIMESTAMP_TIE' : 'LAST_VALID_TOUCH';
  const touches = evaluated.map((touch) => {
    if (touch.touch_token === winner.touch_token) {
      return { ...touch, selected: true, reasons: [decisionReason] };
    }
    if (!touch.eligible) return touch;
    const lostTie = touch.recorded_at === winner.recorded_at;
    return {
      ...touch,
      reasons: [lostTie ? 'TIE_LOST_TO_LATER_SEQUENCE' as const : 'SUPERSEDED_BY_LATER_TOUCH' as const],
    };
  });

  return {
    attribution_type: winner.source,
    selected_touch_token: winner.touch_token,
    reason: decisionReason,
    touches,
  };
}
