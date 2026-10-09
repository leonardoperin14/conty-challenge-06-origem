import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { resolveAttribution } from './attribution.ts';
import {
  ATTRIBUTION_POLICY,
  ATTRIBUTION_WINDOW_MS,
  ApiError,
  type AttributionType,
  type AuditedTouch,
  type SignupDecisionRecord,
  type Source,
  type TouchForDecision,
} from './types.ts';

type LinkRow = { link_id: string; source: Source; reference_id: string };
type TouchRow = TouchForDecision & { sequence: number };
type DecisionRow = {
  signup_id: string;
  installation_id: string;
  signup_at: string;
  signup_sequence: number;
  window_started_at: string;
  window_ends_at: string;
  attribution_type: AttributionType;
  selected_touch_token: string | null;
  reason: SignupDecisionRecord['reason'];
  audit_json: string;
};

function iso(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('The injected clock returned an invalid date.');
  return date.toISOString();
}

export class AttributionStore {
  readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly newToken: () => string;

  constructor(
    databasePath = './data/attribution.sqlite',
    now: () => Date = () => new Date(),
    newToken: () => string = randomUUID,
  ) {
    this.now = now;
    this.newToken = newToken;
    const resolvedPath = databasePath === ':memory:' ? databasePath : resolve(databasePath);
    if (resolvedPath !== ':memory:') mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        link_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('campaign', 'referral', 'community')),
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS click_tokens (
        touch_token TEXT PRIMARY KEY,
        link_id TEXT NOT NULL REFERENCES links(link_id),
        click_id TEXT NOT NULL UNIQUE,
        emitted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('FIRST_OPEN', 'TOUCH', 'SIGNUP')),
        recorded_at TEXT NOT NULL,
        touch_token TEXT REFERENCES click_tokens(touch_token),
        signup_id TEXT,
        CHECK (
          (kind = 'FIRST_OPEN' AND touch_token IS NULL AND signup_id IS NULL) OR
          (kind = 'TOUCH' AND touch_token IS NOT NULL AND signup_id IS NULL) OR
          (kind = 'SIGNUP' AND touch_token IS NULL AND signup_id IS NOT NULL)
        ),
        UNIQUE (installation_id, touch_token),
        UNIQUE (installation_id, signup_id),
        UNIQUE (signup_id)
      );
      CREATE INDEX IF NOT EXISTS events_by_installation ON events(installation_id, sequence);
      CREATE TABLE IF NOT EXISTS installations (
        installation_id TEXT PRIMARY KEY,
        first_open_at TEXT NOT NULL,
        first_open_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence)
      );
      CREATE TABLE IF NOT EXISTS signup_decisions (
        signup_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL UNIQUE REFERENCES installations(installation_id),
        signup_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
        signup_at TEXT NOT NULL,
        window_started_at TEXT NOT NULL,
        window_ends_at TEXT NOT NULL,
        policy TEXT NOT NULL,
        attribution_type TEXT NOT NULL CHECK (attribution_type IN ('campaign', 'referral', 'community', 'organic')),
        selected_touch_token TEXT REFERENCES click_tokens(touch_token),
        reason TEXT NOT NULL,
        audit_json TEXT NOT NULL
      );
    `);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = work();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  createLink(input: { source: Source; reference_id: string }): LinkRow {
    const linkId = this.newToken();
    const createdAt = iso(this.now());
    this.db.prepare('INSERT INTO links(link_id, source, reference_id, created_at) VALUES (?, ?, ?, ?)')
      .run(linkId, input.source, input.reference_id, createdAt);
    return { link_id: linkId, ...input };
  }

  createClick(input: { link_id: string; click_id: string }): { link_id: string; click_id: string; touch_token: string; deep_link: string } {
    return this.transaction(() => {
      const link = this.db.prepare('SELECT link_id FROM links WHERE link_id = ?').get(input.link_id) as { link_id: string } | undefined;
      if (!link) throw new ApiError(404, 'LINK_NOT_FOUND', 'Link was not found.');
      const existing = this.db.prepare('SELECT touch_token, link_id FROM click_tokens WHERE click_id = ?').get(input.click_id) as { touch_token: string; link_id: string } | undefined;
      if (existing) {
        if (existing.link_id !== input.link_id) throw new ApiError(409, 'CLICK_ID_CONFLICT', 'click_id is already assigned to a different link.');
        return { ...input, touch_token: existing.touch_token, deep_link: this.deepLink(existing.touch_token) };
      }
      const touchToken = this.newToken();
      this.db.prepare('INSERT INTO click_tokens(touch_token, link_id, click_id, emitted_at) VALUES (?, ?, ?, ?)')
        .run(touchToken, input.link_id, input.click_id, iso(this.now()));
      return { ...input, touch_token: touchToken, deep_link: this.deepLink(touchToken) };
    });
  }

  private deepLink(token: string): string {
    return `conty://open?touch=${encodeURIComponent(token)}`;
  }

  isKnownToken(token: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM click_tokens WHERE touch_token = ?').get(token));
  }

  firstOpen(installationId: string): { installation_id: string; first_open_at: string; window_ends_at: string; duration_hours: number } {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT first_open_at FROM installations WHERE installation_id = ?').get(installationId) as { first_open_at: string } | undefined;
      if (existing) return this.openResponse(installationId, existing.first_open_at);

      const firstOpenAt = iso(this.now());
      const event = this.db.prepare(`INSERT INTO events(installation_id, kind, recorded_at) VALUES (?, 'FIRST_OPEN', ?)`).run(installationId, firstOpenAt);
      this.db.prepare('INSERT INTO installations(installation_id, first_open_at, first_open_sequence) VALUES (?, ?, ?)')
        .run(installationId, firstOpenAt, Number(event.lastInsertRowid));
      return this.openResponse(installationId, firstOpenAt);
    });
  }

  private openResponse(installationId: string, firstOpenAt: string) {
    return {
      installation_id: installationId,
      first_open_at: firstOpenAt,
      window_ends_at: new Date(Date.parse(firstOpenAt) + ATTRIBUTION_WINDOW_MS).toISOString(),
      duration_hours: ATTRIBUTION_POLICY.window_hours,
    };
  }

  recordTouch(input: { installation_id: string; touch_token: string }): { touch_token: string; recorded_at: string | null; sequence: number | null; duplicate: boolean; ignored_after_signup: boolean } {
    return this.transaction(() => {
      const installation = this.db.prepare('SELECT first_open_at FROM installations WHERE installation_id = ?')
        .get(input.installation_id) as { first_open_at: string } | undefined;
      if (!installation) throw new ApiError(404, 'INSTALLATION_NOT_FOUND', 'First app opening must be registered before a touch.');
      const token = this.db.prepare(`
        SELECT touch_token FROM click_tokens WHERE touch_token = ?
      `).get(input.touch_token) as { touch_token: string } | undefined;
      if (!token) throw new ApiError(404, 'TOUCH_TOKEN_NOT_FOUND', 'Touch token was not issued by this API.');

      const existing = this.db.prepare(`
        SELECT sequence, recorded_at FROM events WHERE installation_id = ? AND kind = 'TOUCH' AND touch_token = ?
      `).get(input.installation_id, input.touch_token) as { sequence: number; recorded_at: string } | undefined;
      const signup = this.db.prepare('SELECT signup_sequence FROM signup_decisions WHERE installation_id = ?')
        .get(input.installation_id) as { signup_sequence: number } | undefined;
      if (existing) {
        return {
          touch_token: input.touch_token,
          recorded_at: existing.recorded_at,
          sequence: existing.sequence,
          duplicate: true,
          ignored_after_signup: existing.sequence > (signup?.signup_sequence ?? Number.MAX_SAFE_INTEGER),
        };
      }

      const recordedAt = iso(this.now());
      const event = this.db.prepare(`INSERT INTO events(installation_id, kind, recorded_at, touch_token) VALUES (?, 'TOUCH', ?, ?)`)
        .run(input.installation_id, recordedAt, input.touch_token);
      const sequence = Number(event.lastInsertRowid);
      return {
        touch_token: input.touch_token,
        recorded_at: recordedAt,
        sequence,
        duplicate: false,
        ignored_after_signup: sequence > (signup?.signup_sequence ?? Number.MAX_SAFE_INTEGER),
      };
    });
  }

  createSignup(input: { signup_id: string; installation_id: string }): SignupDecisionRecord {
    return this.transaction(() => {
      const existingById = this.loadDecision(input.signup_id);
      if (existingById) {
        if (existingById.installation_id !== input.installation_id) throw new ApiError(409, 'SIGNUP_ID_CONFLICT', 'signup_id is already assigned to another installation.');
        return existingById;
      }
      const installation = this.db.prepare('SELECT first_open_at FROM installations WHERE installation_id = ?')
        .get(input.installation_id) as { first_open_at: string } | undefined;
      if (!installation) throw new ApiError(404, 'INSTALLATION_NOT_FOUND', 'First app opening must be registered before signup.');
      const existingForInstall = this.db.prepare('SELECT signup_id FROM signup_decisions WHERE installation_id = ?')
        .get(input.installation_id) as { signup_id: string } | undefined;
      if (existingForInstall) throw new ApiError(409, 'INSTALLATION_ALREADY_REGISTERED', 'This installation already has a signup.');

      const signupAt = iso(this.now());
      const event = this.db.prepare(`INSERT INTO events(installation_id, kind, recorded_at, signup_id) VALUES (?, 'SIGNUP', ?, ?)`)
        .run(input.installation_id, signupAt, input.signup_id);
      const signupSequence = Number(event.lastInsertRowid);
      const rows = this.db.prepare(`
        SELECT e.touch_token, e.recorded_at, e.sequence, l.source, l.reference_id
        FROM events e
        JOIN click_tokens t ON t.touch_token = e.touch_token
        JOIN links l ON l.link_id = t.link_id
        WHERE e.installation_id = ? AND e.kind = 'TOUCH' AND e.sequence < ?
        ORDER BY e.sequence
      `).all(input.installation_id, signupSequence) as unknown as TouchRow[];
      const result = resolveAttribution({
        first_open_at: installation.first_open_at,
        signup_at: signupAt,
        touches: rows,
      });
      const windowEndsAt = new Date(Date.parse(installation.first_open_at) + ATTRIBUTION_WINDOW_MS).toISOString();
      const record: SignupDecisionRecord = {
        signup_id: input.signup_id,
        installation_id: input.installation_id,
        signup_at: signupAt,
        signup_sequence: signupSequence,
        window: {
          started_at: installation.first_open_at,
          ends_at: windowEndsAt,
          duration_hours: ATTRIBUTION_POLICY.window_hours,
        },
        policy: ATTRIBUTION_POLICY,
        attribution_type: result.attribution_type,
        selected_touch_token: result.selected_touch_token,
        reason: result.reason,
        touches: result.touches,
      };
      this.db.prepare(`
        INSERT INTO signup_decisions(
          signup_id, installation_id, signup_sequence, signup_at, window_started_at, window_ends_at,
          policy, attribution_type, selected_touch_token, reason, audit_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.signup_id,
        record.installation_id,
        record.signup_sequence,
        record.signup_at,
        record.window.started_at,
        record.window.ends_at,
        JSON.stringify(record.policy),
        record.attribution_type,
        record.selected_touch_token,
        record.reason,
        JSON.stringify(record.touches),
      );
      return record;
    });
  }

  getAttribution(signupId: string): (SignupDecisionRecord & { later_touches: AuditedTouch[] }) | undefined {
    const decision = this.loadDecision(signupId);
    if (!decision) return undefined;
    const rows = this.db.prepare(`
      SELECT e.touch_token, e.recorded_at, e.sequence, l.source, l.reference_id
      FROM events e
      JOIN click_tokens t ON t.touch_token = e.touch_token
      JOIN links l ON l.link_id = t.link_id
      WHERE e.installation_id = ? AND e.kind = 'TOUCH' AND e.sequence > ?
      ORDER BY e.sequence
    `).all(decision.installation_id, decision.signup_sequence) as unknown as TouchRow[];
    const laterTouches: AuditedTouch[] = rows.map((touch) => ({
      ...touch,
      eligible: false,
      selected: false,
      reasons: ['AFTER_SIGNUP'],
    }));
    return { ...decision, later_touches: laterTouches };
  }

  private loadDecision(signupId: string): SignupDecisionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM signup_decisions WHERE signup_id = ?').get(signupId) as DecisionRow | undefined;
    if (!row) return undefined;
    return {
      signup_id: row.signup_id,
      installation_id: row.installation_id,
      signup_at: row.signup_at,
      signup_sequence: row.signup_sequence,
      window: {
        started_at: row.window_started_at,
        ends_at: row.window_ends_at,
        duration_hours: ATTRIBUTION_POLICY.window_hours,
      },
      policy: ATTRIBUTION_POLICY,
      attribution_type: row.attribution_type,
      selected_touch_token: row.selected_touch_token,
      reason: row.reason,
      touches: JSON.parse(row.audit_json) as AuditedTouch[],
    };
  }

  close(): void {
    this.db.close();
  }
}
