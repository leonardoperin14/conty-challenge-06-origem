import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { AttributionStore } from './store.ts';
import { ApiError, SOURCES } from './types.ts';

const identifier = z.string().trim().min(1).max(200);
const linkBody = z.object({
  source: z.enum(SOURCES),
  reference_id: identifier,
});
const clickBody = z.object({
  link_id: identifier,
  click_id: identifier,
});
const installationBody = z.object({ installation_id: identifier });
const touchBody = z.object({
  installation_id: identifier,
  touch_token: identifier,
});
const signupBody = z.object({
  signup_id: identifier,
  installation_id: identifier,
});

export function createApp(store: AttributionStore, baseUrl = 'http://localhost:3000') {
  const app = new Hono();
  const publicBaseUrl = baseUrl.replace(/\/$/, '');

  app.onError((error, context) => {
    if (error instanceof ZodError) {
      return context.json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Request body does not match the endpoint contract.',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      }, 400);
    }
    if (error instanceof ApiError) {
      return context.json({ error: { code: error.code, message: error.message } }, error.status as 400 | 404 | 409);
    }
    return context.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } }, 500);
  });

  app.get('/health', (context) => context.json({ status: 'ok' }));

  app.post('/links', async (context) => {
    const body = linkBody.parse(await context.req.json());
    const link = store.createLink(body);
    return context.json({
      ...link,
      click_endpoint: `${publicBaseUrl}/clicks`,
    }, 201);
  });

  app.post('/clicks', async (context) => {
    const body = clickBody.parse(await context.req.json());
    const click = store.createClick(body);
    const openUrl = `${publicBaseUrl}/open?touch=${encodeURIComponent(click.touch_token)}`;
    return context.json({
      ...click,
      open_url: openUrl,
      idempotent: true,
    }, 200);
  });

  app.get('/open', (context) => {
    const touchToken = context.req.query('touch');
    if (!touchToken) throw new ApiError(400, 'TOUCH_TOKEN_REQUIRED', 'The touch query parameter is required.');
    if (!store.isKnownToken(touchToken)) throw new ApiError(404, 'TOUCH_TOKEN_NOT_FOUND', 'Touch token was not issued by this API.');
    return context.redirect(`conty://open?touch=${encodeURIComponent(touchToken)}`, 302);
  });

  app.post('/app/first-open', async (context) => {
    const body = installationBody.parse(await context.req.json());
    return context.json(store.firstOpen(body.installation_id), 200);
  });

  app.post('/app/touches', async (context) => {
    const body = touchBody.parse(await context.req.json());
    return context.json(store.recordTouch(body), 200);
  });

  app.post('/signups', async (context) => {
    const body = signupBody.parse(await context.req.json());
    return context.json(store.createSignup(body), 200);
  });

  app.get('/signups/:signupId/attribution', (context) => {
    const audit = store.getAttribution(context.req.param('signupId'));
    if (!audit) throw new ApiError(404, 'SIGNUP_NOT_FOUND', 'Signup was not found.');
    return context.json(audit);
  });

  return app;
}
