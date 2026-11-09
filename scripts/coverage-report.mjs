import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { instrumentSource } from './source-instrumentation.cjs';
import { activeSources, sourcePath, sourceFingerprint, requireCompleteCoverage } from './coverage-scope.mjs';

export function mergeRunnerCoverage(root, runners = ['unit', 'browser', 'native']) {
    const expected = activeSources(root);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'coverage/source-manifest.json'), 'utf8'));
    if (JSON.stringify(manifest) !== JSON.stringify(sourceFingerprint(root))) {
        throw new Error('Stale or incompatible coverage: source content changed since collection began');
    }
    const combined = libCoverage.createCoverageMap({});
    const baseline = new Map();
    for (const name of expected) {
        const filename = path.join(root, name);
        const { coverage } = instrumentSource(fs.readFileSync(filename, 'utf8'), filename);
        baseline.set(name, coverage);
        combined.addFileCoverage(coverage);
    }
    for (const runner of runners) {
        const directory = path.join(root, 'coverage', runner);
        const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => file.endsWith('.json')) : [];
        if (!files.length) throw new Error(`Missing runner coverage: ${runner}`);
        if (!fs.existsSync(path.join(directory, '.passed'))) throw new Error(`Runner has no successful completion marker: ${runner}`);
        let executed = false;
        for (const file of files) {
            const data = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
            for (const [name, counts] of Object.entries(data)) {
                const relative = sourcePath(name, root);
                const original = baseline.get(relative);
                if (!original) throw new Error(`Unexpected coverage source: ${name}`);
                for (const field of ['statementMap', 'fnMap', 'branchMap']) {
                    if (JSON.stringify(original[field]) !== JSON.stringify(counts[field])) {
                        throw new Error(`Stale or incompatible coverage from ${runner}: ${relative}`);
                    }
                }
                executed ||= Object.values(counts.s).some(count => count > 0);
                combined.addFileCoverage(counts);
            }
        }
        if (!executed) throw new Error(`Runner executed no source statements: ${runner}`);
    }
    requireCompleteCoverage(combined.toJSON(), expected);
    return combined;
}

export function generateCoverage(root = process.cwd(), check = false) {
    const combined = mergeRunnerCoverage(root);
    const context = libReport.createContext({ dir: path.join(root, 'coverage/combined'), coverageMap: combined });
    for (const name of ['text', 'json', 'json-summary', 'html']) reports.create(name).execute(context);
    const summary = combined.getCoverageSummary().toJSON();
    if (check) {
        const gaps = ['statements', 'branches', 'functions', 'lines'].filter(metric => summary[metric].covered !== summary[metric].total);
        if (gaps.length) throw new Error(`100% coverage target not reached: ${gaps.join(', ')}`);
    }
    return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try { generateCoverage(process.cwd(), process.argv.includes('--check')); }
    catch (error) { console.error(error); process.exitCode = 1; }
}
