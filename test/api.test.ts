import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { AttributionStore } from '../src/store.ts';
import { ATTRIBUTION_WINDOW_MS } from '../src/types.ts';

const initialTime = Date.parse('2026-10-09T12:00:00.000Z');

function fixture(databasePath = ':memory:') {
  let time = initialTime;
  let tokenCounter = 0;
  const store = new AttributionStore(databasePath, () => new Date(time), () => `issued-${++tokenCounter}`);
  const app = createApp(store, 'http://test.local');
  return {
    store,
    app,
    setTime(value: number) { time = value; },
    async request(path: string, method: string, body?: unknown) {
      const response = await app.request(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() as Record<string, any>
        : null;
      return { response, payload };
    },
  };
}

test('campaign and referral clicks are deduplicated and produce an auditable last-touch signup', async () => {
  const f = fixture();
  try {
    const campaign = await f.request('/links', 'POST', { source: 'campaign', reference_id: 'tiktok-2026' });
    assert.equal(campaign.response.status, 201);
    const referral = await f.request('/links', 'POST', { source: 'referral', reference_id: 'creator-42' });
    const campaignClick = await f.request('/clicks', 'POST', { link_id: campaign.payload!.link_id, click_id: 'click-campaign-1' });
    const campaignRetry = await f.request('/clicks', 'POST', { link_id: campaign.payload!.link_id, click_id: 'click-campaign-1' });
    assert.equal(campaignClick.payload!.touch_token, campaignRetry.payload!.touch_token);
    assert.equal(campaignClick.payload!.deep_link, `conty://open?touch=${campaignClick.payload!.touch_token}`);
    const openUrl = new URL(campaignClick.payload!.open_url);
    const redirect = await f.request(`${openUrl.pathname}${openUrl.search}`, 'GET');
    assert.equal(redirect.response.status, 302);
    assert.equal(redirect.response.headers.get('location'), campaignClick.payload!.deep_link);
    const referralClick = await f.request('/clicks', 'POST', { link_id: referral.payload!.link_id, click_id: 'click-referral-1' });
    assert.notEqual(campaignClick.payload!.touch_token, referralClick.payload!.touch_token);

    const installation = await f.request('/app/first-open', 'POST', { installation_id: 'install-1' });
    assert.equal(installation.payload!.duration_hours, 168);
    f.setTime(initialTime + 60_000);
    const firstTouch = await f.request('/app/touches', 'POST', { installation_id: 'install-1', touch_token: campaignClick.payload!.touch_token });
    const duplicateTouch = await f.request('/app/touches', 'POST', { installation_id: 'install-1', touch_token: campaignClick.payload!.touch_token });
    assert.equal(firstTouch.payload!.duplicate, false);
    assert.equal(duplicateTouch.payload!.duplicate, true);

    f.setTime(initialTime + 86_400_000);
    await f.request('/app/touches', 'POST', { installation_id: 'install-1', touch_token: referralClick.payload!.touch_token });
    f.setTime(initialTime + 2 * 86_400_000);
    const signup = await f.request('/signups', 'POST', { signup_id: 'signup-1', installation_id: 'install-1' });
    assert.equal(signup.payload!.attribution_type, 'referral');
    assert.equal(signup.payload!.selected_touch_token, referralClick.payload!.touch_token);
    assert.equal(signup.payload!.touches.length, 2);
    assert.deepEqual(signup.payload!.touches[0].reasons, ['SUPERSEDED_BY_LATER_TOUCH']);
    assert.deepEqual(signup.payload!.touches[1].reasons, ['LAST_VALID_TOUCH']);

    const replayedSignup = await f.request('/signups', 'POST', { signup_id: 'signup-1', installation_id: 'install-1' });
    assert.deepEqual(replayedSignup.payload, signup.payload);
    assert.equal((await f.request('/clicks', 'POST', { link_id: campaign.payload!.link_id, click_id: 'click-after-signup' })).response.status, 200);
    const afterClick = await f.request('/clicks', 'POST', { link_id: campaign.payload!.link_id, click_id: 'click-after-signup' });
    f.setTime(initialTime + 3 * 86_400_000);
    const lateTouch = await f.request('/app/touches', 'POST', { installation_id: 'install-1', touch_token: afterClick.payload!.touch_token });
    assert.equal(lateTouch.payload!.ignored_after_signup, true);

    const audit = await f.request('/signups/signup-1/attribution', 'GET');
    assert.equal(audit.payload!.attribution_type, 'referral');
    assert.equal(audit.payload!.later_touches.length, 1);
    assert.deepEqual(audit.payload!.later_touches[0].reasons, ['AFTER_SIGNUP']);
  } finally {
    f.store.close();
  }
});

test('two touches at the same timestamp use persisted sequence as the tie-break', async () => {
  const f = fixture();
  try {
    const campaign = await f.request('/links', 'POST', { source: 'campaign', reference_id: 'campaign-a' });
    const referral = await f.request('/links', 'POST', { source: 'referral', reference_id: 'creator-b' });
    const a = await f.request('/clicks', 'POST', { link_id: campaign.payload!.link_id, click_id: 'tie-a' });
    const b = await f.request('/clicks', 'POST', { link_id: referral.payload!.link_id, click_id: 'tie-b' });
    await f.request('/app/first-open', 'POST', { installation_id: 'install-tie' });
    await f.request('/app/touches', 'POST', { installation_id: 'install-tie', touch_token: a.payload!.touch_token });
    await f.request('/app/touches', 'POST', { installation_id: 'install-tie', touch_token: b.payload!.touch_token });
    const signup = await f.request('/signups', 'POST', { signup_id: 'signup-tie', installation_id: 'install-tie' });
    assert.equal(signup.payload!.selected_touch_token, b.payload!.touch_token);
    assert.equal(signup.payload!.reason, 'LATEST_SEQUENCE_ON_TIMESTAMP_TIE');
    assert.deepEqual(signup.payload!.touches[0].reasons, ['TIE_LOST_TO_LATER_SEQUENCE']);
    assert.deepEqual(signup.payload!.touches[1].reasons, ['LATEST_SEQUENCE_ON_TIMESTAMP_TIE']);
  } finally {
    f.store.close();
  }
});

test('the window is fixed, inclusive at its endpoint, and expired signups are organic', async () => {
  const f = fixture();
  try {
    const link = await f.request('/links', 'POST', { source: 'community', reference_id: 'artists' });
    const click = await f.request('/clicks', 'POST', { link_id: link.payload!.link_id, click_id: 'edge-click' });
    const first = await f.request('/app/first-open', 'POST', { installation_id: 'install-edge' });
    f.setTime(initialTime + ATTRIBUTION_WINDOW_MS);
    const repeatedFirst = await f.request('/app/first-open', 'POST', { installation_id: 'install-edge' });
    assert.equal(repeatedFirst.payload!.first_open_at, first.payload!.first_open_at);
    await f.request('/app/touches', 'POST', { installation_id: 'install-edge', touch_token: click.payload!.touch_token });
    const signup = await f.request('/signups', 'POST', { signup_id: 'signup-edge', installation_id: 'install-edge' });
    assert.equal(signup.payload!.attribution_type, 'community');

    f.setTime(initialTime);
    await f.request('/app/first-open', 'POST', { installation_id: 'install-expired' });
    const expiredClick = await f.request('/clicks', 'POST', { link_id: link.payload!.link_id, click_id: 'expired-click' });
    f.setTime(initialTime + ATTRIBUTION_WINDOW_MS + 1);
    await f.request('/app/touches', 'POST', { installation_id: 'install-expired', touch_token: expiredClick.payload!.touch_token });
    const expiredSignup = await f.request('/signups', 'POST', { signup_id: 'signup-expired', installation_id: 'install-expired' });
    assert.equal(expiredSignup.payload!.attribution_type, 'organic');
    assert.equal(expiredSignup.payload!.reason, 'SIGNUP_AFTER_WINDOW');
    assert.deepEqual(expiredSignup.payload!.touches[0].reasons, ['OUTSIDE_WINDOW', 'SIGNUP_AFTER_WINDOW']);
  } finally {
    f.store.close();
  }
});

test('organic signup, invalid requests, and conflicting identities return explicit outcomes', async () => {
  const f = fixture();
  try {
    const empty = await f.request('/app/first-open', 'POST', { installation_id: 'install-organic' });
    const signup = await f.request('/signups', 'POST', { signup_id: 'signup-organic', installation_id: 'install-organic' });
    assert.equal(signup.payload!.attribution_type, 'organic');
    assert.equal(signup.payload!.reason, 'NO_VALID_TOUCH');
    assert.equal(signup.payload!.window.started_at, empty.payload!.first_open_at);

    const invalidLink = await f.request('/links', 'POST', { source: 'mystery', reference_id: 'x' });
    assert.equal(invalidLink.response.status, 400);
    assert.equal(invalidLink.payload!.error.code, 'INVALID_REQUEST');
    const unknownTouch = await f.request('/app/touches', 'POST', { installation_id: 'install-organic', touch_token: 'missing' });
    assert.equal(unknownTouch.response.status, 404);
    const conflict = await f.request('/signups', 'POST', { signup_id: 'signup-other', installation_id: 'install-organic' });
    assert.equal(conflict.response.status, 409);
  } finally {
    f.store.close();
  }
});

test('all POST endpoints reject malformed and empty JSON before writing', async () => {
  const f = fixture();
  const writeCalls: string[] = [];
  const originalCreateLink = f.store.createLink.bind(f.store);
  const originalCreateClick = f.store.createClick.bind(f.store);
  const originalFirstOpen = f.store.firstOpen.bind(f.store);
  const originalRecordTouch = f.store.recordTouch.bind(f.store);
  const originalCreateSignup = f.store.createSignup.bind(f.store);
  f.store.createLink = (input) => { writeCalls.push('createLink'); return originalCreateLink(input); };
  f.store.createClick = (input) => { writeCalls.push('createClick'); return originalCreateClick(input); };
  f.store.firstOpen = (installationId) => { writeCalls.push('firstOpen'); return originalFirstOpen(installationId); };
  f.store.recordTouch = (input) => { writeCalls.push('recordTouch'); return originalRecordTouch(input); };
  f.store.createSignup = (input) => { writeCalls.push('createSignup'); return originalCreateSignup(input); };

  const routes = ['/links', '/clicks', '/app/first-open', '/app/touches', '/signups'];
  try {
    for (const path of routes) {
      for (const body of ['{', '']) {
        const response = await f.app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        const payload = await response.json() as Record<string, any>;
        assert.equal(response.status, 400, `${path} should reject ${body === '' ? 'an empty body' : 'malformed JSON'}`);
        assert.equal(payload.error.code, 'INVALID_REQUEST');
      }
    }

    assert.deepEqual(writeCalls, []);
    for (const table of ['links', 'click_tokens', 'events', 'installations', 'signup_decisions']) {
      const row = f.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      assert.equal(row.count, 0, `${table} should remain empty`);
    }
  } finally {
    f.store.close();
  }
});

test('a SyntaxError thrown by store logic remains an internal 500', async () => {
  const f = fixture();
  try {
    f.store.createLink = () => { throw new SyntaxError('store implementation failure'); };
    const response = await f.app.request('/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'campaign', reference_id: 'valid-link' }),
    });
    const payload = await response.json() as Record<string, any>;

    assert.equal(response.status, 500);
    assert.equal(payload.error.code, 'INTERNAL_ERROR');
  } finally {
    f.store.close();
  }
});

test('persisted signup decisions and audit survive reopening the SQLite database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'conty-attribution-'));
  const databasePath = join(directory, 'attribution.sqlite');
  const first = fixture(databasePath);
  try {
    const link = await first.request('/links', 'POST', { source: 'campaign', reference_id: 'newsletter' });
    const click = await first.request('/clicks', 'POST', { link_id: link.payload!.link_id, click_id: 'persisted-click' });
    await first.request('/app/first-open', 'POST', { installation_id: 'install-persisted' });
    await first.request('/app/touches', 'POST', { installation_id: 'install-persisted', touch_token: click.payload!.touch_token });
    const signup = await first.request('/signups', 'POST', { signup_id: 'signup-persisted', installation_id: 'install-persisted' });
    first.store.close();

    const reopened = fixture(databasePath);
    try {
      const audit = await reopened.request('/signups/signup-persisted/attribution', 'GET');
      assert.equal(audit.payload!.attribution_type, signup.payload!.attribution_type);
      assert.equal(audit.payload!.selected_touch_token, click.payload!.touch_token);
      const repeatedTouch = await reopened.request('/app/touches', 'POST', { installation_id: 'install-persisted', touch_token: click.payload!.touch_token });
      assert.equal(repeatedTouch.payload!.duplicate, true);
    } finally {
      reopened.store.close();
    }
  } finally {
    try { first.store.close(); } catch { /* already closed before reopening */ }
    rmSync(directory, { recursive: true, force: true });
  }
});
