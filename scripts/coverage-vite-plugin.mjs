import { instrumentSource } from './source-instrumentation.cjs';
import { isActiveSource } from './coverage-scope.mjs';

export function sourceCoveragePlugin() {
    return {
        name: 'slate-source-coverage',
        enforce: 'pre',
        transform(code, id) {
            if (!process.env.SLATE_SOURCE_COVERAGE || !isActiveSource(id)) return;
            const output = instrumentSource(code, id.split('?', 1)[0]);
            return { code: output.code, map: output.map };
        },
    };
}
