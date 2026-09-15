// A per-key request cap for one route: at most `limit` hits per `windowMs`, in
// memory.
//
// server.js uses express-rate-limit, but its memory store starts a cleanup
// interval the moment a limiter is created. routes/shop.js is also loaded by
// tools that must not gain timers (tools/healthReport.js), so the caps defined
// there use this instead: no timer at all, old keys are dropped when a request
// finds the map over its size. A restart forgets every count, which is fine for
// a cap measured in minutes.
//
//   const take = windowLimit({ limit: 6, windowMs: 60 * 1000 });
//   if (!take(key)) return res.status(429)...
function windowLimit({ limit, windowMs, maxKeys = 10000 }) {
  if (!(limit > 0) || !(windowMs > 0)) throw new Error('windowLimit needs a positive limit and window');
  const hits = new Map();

  return function take(key, now = Date.now()) {
    const k = String(key);
    let w = hits.get(k);
    if (!w || now - w.start >= windowMs) {
      // Re-inserted so the map stays ordered oldest window first, which is
      // the order the trim below drops them in.
      hits.delete(k);
      w = { start: now, count: 0 };
      hits.set(k, w);
      if (hits.size > maxKeys) {
        for (const other of hits.keys()) {
          if (hits.size <= maxKeys) break;
          if (other !== k) hits.delete(other);
        }
      }
    }
    if (w.count >= limit) return false;
    w.count += 1;
    return true;
  };
}

module.exports = { windowLimit };
