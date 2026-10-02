// Async route handlers and Express 4 (audit 2026-10-01).
//
// Express 4 calls a route handler and ignores what it returns, so when an async handler throws, the rejected promise
// reaches nobody. The process 'unhandledRejection' logger in server.js keeps the site up, but the request never gets
// an answer and the client waits until it gives up. A crafted request does this on purpose, on the PayPal return pages
// without signing in: ?order[toString]=1 (Express's qs parser builds an object whose toString is not a function, so
// parseInt throws), or {"productId":{"toString":1}} in a JSON body (SQLite refuses to bind an object).
//
// routeAsyncRejections() walks the routes registered so far, mounted routers included, and wraps every async route
// handler so that a rejection before any answer goes to next(err), where server.js's catch-all answers 500 JSON. A
// rejection after the answer has started is only logged, as the process logger did before: handing it to Express then
// would make Express cut the connection. Plain (non-async) handlers, which Express 4 already catches, and error
// handlers are left as they are. Nothing changes for a handler that does not reject.

function isAsyncFunction(fn) {
  return typeof fn === 'function' && fn.constructor && fn.constructor.name === 'AsyncFunction';
}

function catchRejections(fn) {
  return function asyncRoute(req, res, next) {
    fn(req, res, next).catch((err) => {
      if (res.headersSent) {
        console.error('[express] route failed after answering:', err && (err.stack || err.message || err));
        return;
      }
      next(err);
    });
  };
}

// stack: app._router.stack, or a Router's .stack. Returns how many handlers it wrapped; a second call wraps none.
function routeAsyncRejections(stack) {
  let wrapped = 0;
  for (const layer of stack || []) {
    if (layer.route) {
      for (const step of layer.route.stack) {
        if (isAsyncFunction(step.handle) && step.handle.length < 4) {
          step.handle = catchRejections(step.handle);
          wrapped++;
        }
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      wrapped += routeAsyncRejections(layer.handle.stack); // a mounted router (routes/shop.js, routes/economy.js)
    }
  }
  return wrapped;
}

module.exports = { routeAsyncRejections, catchRejections };
