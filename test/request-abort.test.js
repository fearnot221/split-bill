'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { bindClientAbort } = require('../lib/request-abort');

test('aborts upstream work when the request or client connection ends early', () => {
  for (const event of ['aborted', 'close']) {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writableEnded = false;
    const binding = bindClientAbort(req, res);
    (event === 'aborted' ? req : res).emit(event);
    assert.equal(binding.controller.signal.aborted, true, event);
    binding.cleanup();
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
});

test('does not abort after a response finishes normally', () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = true;
  const binding = bindClientAbort(req, res);
  res.emit('close');
  assert.equal(binding.controller.signal.aborted, false);
  binding.cleanup();
});
