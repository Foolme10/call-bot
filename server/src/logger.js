'use strict';

// Minimal leveled logger. Swap for pino/winston later if you need structured logs.
function ts() {
  return new Date().toISOString();
}

function log(level, args) {
  const line = `${ts()} [${level}]`;
  if (level === 'ERROR') console.error(line, ...args);
  else if (level === 'WARN') console.warn(line, ...args);
  else console.log(line, ...args);
}

module.exports = {
  info: (...a) => log('INFO', a),
  warn: (...a) => log('WARN', a),
  error: (...a) => log('ERROR', a),
  debug: (...a) => {
    if (process.env.DEBUG) log('DEBUG', a);
  },
};
