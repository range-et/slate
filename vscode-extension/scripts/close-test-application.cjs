/** Close an owned QA application after its assertions, bounding OS shutdown. */
async function closeTestApplication(app, graceMs = 10000, warn = console.warn) {
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw new Error('Shutdown grace must be positive');
    const child = app.process();
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (exited()) return;
    let timer;
    let exitListener;
    let errorListener;
    let forceTimer;
    const forced = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            if (exited()) return resolve();
            exitListener = () => resolve();
            errorListener = reject;
            child.once('exit', exitListener);
            child.once('error', errorListener);
            forceTimer = setTimeout(() => reject(new Error('QA process did not exit after forced shutdown')), graceMs);
            try {
                warn(`VS Code QA shutdown exceeded ${graceMs}ms; closing its owned test process.`);
                child.kill('SIGKILL');
                if (exited()) resolve();
            } catch (error) { reject(error); }
        }, graceMs);
    });
    try {
        await Promise.race([app.close(), forced]);
    } finally {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        if (exitListener) child.removeListener('exit', exitListener);
        if (errorListener) child.removeListener('error', errorListener);
    }
}
module.exports = { closeTestApplication };
