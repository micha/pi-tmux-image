function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive and finite`);
  }
}

/** Scheduling only: no viewport, event queue, promise, pixel or reservation ownership.
 * schedule and defer must enqueue, never invoke inline, and must not throw.
 * cancelScheduled must also be nonthrowing. Adapter failure recovery is outside
 * this accepted injection contract. now is monotonic milliseconds.
 * A receipt is local component production, NOT terminal/display acknowledgement.
 * idleMs is an explicit experiment/policy input; this module selects no default.
 */
export function createViewerPacer({ now, schedule, cancelScheduled, defer, idleMs,
  onEligible, onError } = {}) {
  for (const [name, value] of Object.entries({ now, schedule, cancelScheduled, defer, onEligible })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  positive(idleMs, 'idleMs');
  let lastNow = -Infinity;
  function time() {
    const value = now();
    if (!Number.isFinite(value) || value < lastNow) {
      throw new RangeError('now must return finite monotonic milliseconds');
    }
    lastNow = value;
    return value;
  }

  let nextDue = time();
  let cancelled = false;
  let demanded = false;
  let phase = 'idle';
  let sequence = 0;
  let active = null;
  let timer = null;
  let continuationQueued = false;

  function arm() {
    if (cancelled || !demanded || phase !== 'idle' || timer) return;
    // Each timer has its own identity: even an already queued canceled callback
    // cannot clear a replacement timer or enter another instance's controller.
    const scheduled = {};
    timer = scheduled;
    scheduled.handle = schedule(() => {
      if (cancelled || timer !== scheduled) return;
      timer = null;
      if (!demanded || phase !== 'idle') return;
      if (time() < nextDue) { arm(); return; }
      demanded = false;
      active = Object.freeze({}); // Opaque identity; controller owns its sample.
      sequence += 1;
      phase = 'admitted';
      const ticket = active;
      try {
        onEligible(ticket);
      } catch (error) {
        // Only uncommitted admission can be defensively settled. Publication
        // may already have written bytes: preserve its own-receipt obligation
        // (including a queued cooldown continuation) despite the exception.
        if (matches(ticket, 'admitted')) {
          active = null;
          phase = 'idle';
          nextDue = time() + idleMs;
          arm();
        }
        if (onError) onError(error);
        else throw error;
      }
    }, Math.max(0, nextDue - time()));
  }

  function matches(ticket, expected) {
    return !cancelled && active !== null && ticket === active && phase === expected;
  }

  return Object.freeze({
    request() {
      if (cancelled) return;
      demanded = true;
      arm();
    },
    published(ticket) {
      if (!matches(ticket, 'admitted')) return false;
      phase = 'awaiting-receipt';
      return true;
    },
    rendered(ticket) {
      if (!matches(ticket, 'awaiting-receipt')) return false;
      phase = 'cooldown-pending';
      continuationQueued = true;
      defer(() => {
        if (!matches(ticket, 'cooldown-pending')) return;
        continuationQueued = false;
        active = null;
        phase = 'idle';
        // Include surrounding host/event-loop work through this deferred first
        // own receipt boundary. This is a timing proxy, not a measured ACK.
        nextDue = time() + idleMs;
        arm();
      });
      return true;
    },
    settled(ticket, { retry = false } = {}) {
      if (!matches(ticket, 'admitted')) return false;
      active = null;
      phase = 'idle';
      demanded = demanded || retry;
      nextDue = time() + idleMs;
      arm();
      return true;
    },
    // External-wake-only no-work path. Do not poll or immediately request again
    // unless controller observations establish genuinely eligible work.
    blocked(ticket) {
      if (!matches(ticket, 'admitted')) return false;
      active = null;
      phase = 'idle';
      demanded = false;
      return true;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      demanded = false;
      active = null;
      phase = 'idle';
      continuationQueued = false;
      const old = timer;
      timer = null;
      if (old) cancelScheduled(old.handle);
    },
    inspect() {
      return { cancelled, demanded, timerArmed: timer !== null,
        continuationQueued, phase, sequence, nextDue };
    },
  });
}

/** Expire only an unconsumed local wheel slot; never expire admitted zoom work.
 * null explicitly disables expiry. Neither omission nor zero selects a policy.
 */
export function isWheelExpired(receivedAt, now, limitMs) {
  if (!Number.isFinite(receivedAt) || !Number.isFinite(now)) {
    throw new RangeError('wheel timestamps must be finite');
  }
  if (limitMs === null) return false;
  positive(limitMs, 'limitMs');
  return now - receivedAt >= limitMs;
}
