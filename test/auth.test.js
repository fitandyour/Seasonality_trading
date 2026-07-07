const test = require('node:test');
const assert = require('node:assert/strict');
const { requireAuth } = require('../auth');

test('requireAuth passes through when session has userId', () => {
  let nexted = false;
  requireAuth({ session: { userId: 1 } }, {}, () => { nexted = true; });
  assert.equal(nexted, true);
});

test('requireAuth redirects to /login when no session user', () => {
  let redirectedTo = null;
  const res = { redirect: (url) => { redirectedTo = url; } };
  requireAuth({ session: {} }, res, () => { throw new Error('must not call next'); });
  assert.equal(redirectedTo, '/login');
});
