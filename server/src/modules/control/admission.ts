/** Control-plane admission: the middleware that reserves a session before a browser is provisioned. */
import { registry } from '../browsers/registry.ts';
import { container } from '../../app/container.ts';
import * as keyConfig from '../config/service.ts';
import { Status } from '../../platform/http-status.ts';
import { BEARER_PREFIX } from './http/constants.ts';
import { reserve, answerReplay, starting, persistOutcome } from './http/admission.ts';
import { startAs } from './http/start-as.ts';
import { nothingToStart } from '../browsers/lifecycle/start-connected.ts';
import { refusal } from '../browsers/lifecycle/sessions.ts';
import { audit } from '../../platform/audit.ts';

// Not yet layered: reads the persona and group services from the composition root.
const { personas, groups } = container;

/** Persist a reservation before invoking any external provider. */
export function admission(defaultProvider?) {
  return async (req, res, next) => {
    const key = req.headers.authorization.slice(BEARER_PREFIX.length);
    try {
      await admit(key, req, res, next, defaultProvider);
    } catch (err) {
      res.status(err.status || Status.UNAVAILABLE).json({ error: err.message, code: err.code });
    }
  };
}

/**
 * Reserves the session, then answers a replay or a queued start, or lets the
 * start proceed. The persona the session runs as is read back from the
 * reservation: for a group start the reservation is where it was chosen.
 */
async function admit(key, req, res, next, defaultProvider) {
  if (registry.draining) return res.status(Status.UNAVAILABLE).json({ error: 'Server is draining', code: 'draining' });
  const { provider, target } = await chooseTarget(key, req, defaultProvider);
  if (refuseUnstartable(key, req, res, provider)) return;
  const reservation = await reserve(key, req, provider, target);
  if (reservation.replay) return answerReplay(key, req, res, reservation);
  if (reservation.state === 'queued') return answerQueued(res, provider, reservation);
  proceed(key, req, res, reservation);
  next();
}

/** Answers 202: the start is reserved and waits for capacity. */
function answerQueued(res, provider, reservation) {
  return res.status(Status.ACCEPTED).json(starting(reservation.id, provider, reservation.persona, 'queued'));
}

/**
 * A start that names no provider, has nothing to dial and no browser of the
 * key's to hand over can only be refused, so it is refused here, before a
 * session is reserved. Reserved first, it became a failed session with a
 * provisioning and a failed event behind it, and a webhook call for each, on
 * every retry of a client that is not set up yet. Audited as the handler would.
 */
function refuseUnstartable(key, req, res, provider): boolean {
  if (!req.path.endsWith('/start')) return false;
  const err = nothingToStart(req, key, provider);
  if (!err) return false;
  audit({ action: 'browser.start', actorKey: key, outcome: 'error', meta: { provider, error: err.message }, req });
  res.status(err.status).json(refusal(err));
  return true;
}

/** The provider to start on and, for a start, what it runs as: a persona, or a group's members. */
async function chooseTarget(key, req, defaultProvider) {
  const provider = req.body?.provider || defaultProvider || keyConfig.providerFor(key);
  const target = req.path.endsWith('/start') ? await startAs({ personas, groups }, key, req.body) : {};
  return { provider, target };
}

/** Binds the reservation to the request, as the persona it runs as, and persists whatever the start handler answers. */
function proceed(key, req, res, reservation) {
  req.controlSession = reservation;
  if (reservation.persona) req.body = { ...req.body, persona: reservation.persona, profile: reservation.persona };
  persistOutcome(key, reservation, res);
}
