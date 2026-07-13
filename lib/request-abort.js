'use strict';

function bindClientAbort(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnDisconnect = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', abortOnDisconnect);
  return {
    controller,
    cleanup() {
      req.off('aborted', abort);
      res.off('close', abortOnDisconnect);
    },
  };
}

module.exports = { bindClientAbort };
