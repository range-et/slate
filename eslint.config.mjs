import tseslint from 'typescript-eslint';

// Target active product code; the frozen legacy application has its own gate.
export default [{
    files: ['src/harness/**/*.{ts,tsx}', 'vscode-extension/src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
        'constructor-super': 'error',
        'no-async-promise-executor': 'error',
        'no-compare-neg-zero': 'error',
        'no-cond-assign': ['error', 'always'],
        'no-dupe-else-if': 'error',
        'no-duplicate-case': 'error',
        'no-sparse-arrays': 'error',
        'no-unsafe-finally': 'error',
        'use-isnan': 'error',
        'valid-typeof': 'error',
    },
}];
