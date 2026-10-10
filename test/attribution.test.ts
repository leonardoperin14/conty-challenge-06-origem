import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAttribution } from '../src/attribution.ts';
import { ATTRIBUTION_WINDOW_MS, type TouchForDecision } from '../src/types.ts';

const start = '2026-10-09T12:00:00.000Z';
const firstTouch: TouchForDecision = {
  touch_token: 'touch-a',
  source: 'campaign',
  reference_id: 'tiktok-2026',
  recorded_at: '2026-10-09T13:00:00.000Z',
  sequence: 2,
};

test('last eligible touch wins and the earlier touch records why it lost', () => {
  const result = resolveAttribution({
    first_open_at: start,
    signup_at: '2026-10-10T12:00:00.000Z',
    touches: [firstTouch, {
      touch_token: 'touch-b',
      source: 'referral',
      reference_id: 'creator-42',
      recorded_at: '2026-10-10T11:00:00.000Z',
      sequence: 3,
    }],
  });

  assert.equal(result.attribution_type, 'referral');
  assert.equal(result.selected_touch_token, 'touch-b');
  assert.equal(result.touches[0]?.selected, false);
  assert.deepEqual(result.touches[0]?.reasons, ['SUPERSEDED_BY_LATER_TOUCH']);
  assert.equal(result.touches[1]?.selected, true);
  assert.deepEqual(result.touches[1]?.reasons, ['LAST_VALID_TOUCH']);
});

test('when timestamps tie, the later persisted sequence wins', () => {
  const tiedTouch = { ...firstTouch, touch_token: 'touch-b', source: 'referral' as const, sequence: 3 };
  const result = resolveAttribution({
    first_open_at: start,
    signup_at: '2026-10-09T13:00:00.000Z',
    touches: [firstTouch, tiedTouch],
  });

  assert.equal(result.selected_touch_token, 'touch-b');
  assert.equal(result.reason, 'LATEST_SEQUENCE_ON_TIMESTAMP_TIE');
  assert.deepEqual(result.touches[0]?.reasons, ['TIE_LOST_TO_LATER_SEQUENCE']);
  assert.deepEqual(result.touches[1]?.reasons, ['LATEST_SEQUENCE_ON_TIMESTAMP_TIE']);
});

test('equivalent offset timestamps tie by instant in either input order and retain their original strings', () => {
  const earlierTouch: TouchForDecision = {
    ...firstTouch,
    touch_token: 'touch-earlier',
    recorded_at: '2026-10-09T12:59:59.999Z',
    sequence: 4,
  };
  const equivalentTimestamps = [
    '2026-10-09T10:00:00.000-03:00',
    '2026-10-09T15:00:00.000+02:00',
  ];

  for (const [index, offsetTimestamp] of equivalentTimestamps.entries()) {
    const offsetTouch: TouchForDecision = {
      ...firstTouch,
      touch_token: `touch-offset-${index}`,
      source: 'referral',
      recorded_at: offsetTimestamp,
      sequence: 3,
    };
    const touches = index === 0
      ? [firstTouch, offsetTouch, earlierTouch]
      : [earlierTouch, offsetTouch, firstTouch];
    const result = resolveAttribution({
      first_open_at: start,
      signup_at: '2026-10-09T14:00:00.000Z',
      touches,
    });
    const byToken = new Map(result.touches.map((touch) => [touch.touch_token, touch]));

    assert.equal(result.selected_touch_token, offsetTouch.touch_token);
    assert.equal(result.reason, 'LATEST_SEQUENCE_ON_TIMESTAMP_TIE');
    assert.deepEqual(byToken.get(firstTouch.touch_token)?.reasons, ['TIE_LOST_TO_LATER_SEQUENCE']);
    assert.deepEqual(byToken.get(offsetTouch.touch_token)?.reasons, ['LATEST_SEQUENCE_ON_TIMESTAMP_TIE']);
    assert.deepEqual(byToken.get(earlierTouch.touch_token)?.reasons, ['SUPERSEDED_BY_LATER_TOUCH']);
    assert.equal(byToken.get(firstTouch.touch_token)?.recorded_at, firstTouch.recorded_at);
    assert.equal(byToken.get(offsetTouch.touch_token)?.recorded_at, offsetTimestamp);
  }
});

test('the end of the fixed window is inclusive and one millisecond after is outside', () => {
  const end = new Date(Date.parse(start) + ATTRIBUTION_WINDOW_MS).toISOString();
  const inclusive = resolveAttribution({
    first_open_at: start,
    signup_at: end,
    touches: [{ ...firstTouch, recorded_at: end }],
  });
  assert.equal(inclusive.selected_touch_token, firstTouch.touch_token);

  const outsideAt = new Date(Date.parse(end) + 1).toISOString();
  const outside = resolveAttribution({
    first_open_at: start,
    signup_at: outsideAt,
    touches: [{ ...firstTouch, recorded_at: outsideAt }],
  });
  assert.equal(outside.attribution_type, 'organic');
  assert.equal(outside.reason, 'SIGNUP_AFTER_WINDOW');
  assert.deepEqual(outside.touches[0]?.reasons, ['OUTSIDE_WINDOW', 'SIGNUP_AFTER_WINDOW']);
});

test('a touch with a timestamp after signup is ineligible even if its sequence was lower', () => {
  const result = resolveAttribution({
    first_open_at: start,
    signup_at: '2026-10-09T13:00:00.000Z',
    touches: [{ ...firstTouch, recorded_at: '2026-10-09T13:00:00.001Z' }],
  });
  assert.equal(result.attribution_type, 'organic');
  assert.deepEqual(result.touches[0]?.reasons, ['AFTER_SIGNUP']);
});

test('an empty history receives an explicit organic reason', () => {
  const result = resolveAttribution({ first_open_at: start, signup_at: start, touches: [] });
  assert.equal(result.attribution_type, 'organic');
  assert.equal(result.reason, 'NO_VALID_TOUCH');
});
