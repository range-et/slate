const { createInstrumenter } = require('istanbul-lib-instrument');
const path = require('node:path');

function instrumentSource(code, filename) {
    const instrumenter = createInstrumenter({
        esModules: true,
        parserPlugins: ['typescript', 'jsx'],
        produceSourceMap: true,
        compact: false,
    });
    const resolved = filename.startsWith('/') ? path.posix.resolve(filename) : path.resolve(filename);
    const output = instrumenter.instrumentSync(code, resolved);
    return { code: output, map: instrumenter.lastSourceMap(), coverage: instrumenter.lastFileCoverage() };
}

module.exports = { instrumentSource };
