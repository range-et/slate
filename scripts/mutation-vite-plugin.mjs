/** Carry Stryker's command-runner mutation into browsers before modules execute.
 * Node/Extension Host reads this variable directly; browsers have no process.env.
 * Harness HTML receives its normal CSP nonce when VS Code loads the built page.
 */
export function mutationBridgePlugin() {
    return {
        name: 'slate-mutation-bridge',
        transformIndexHtml: {
            order: 'pre',
            handler() {
                const active = process.env.__STRYKER_ACTIVE_MUTANT__;
                if (active === undefined) return [];
                if (!/^\d+$/.test(active)) throw new Error('Invalid Stryker active mutant ID');
                return [{
                    tag: 'script',
                    injectTo: 'head-prepend',
                    children: `globalThis.__stryker__ = globalThis.__stryker__ || {}; globalThis.__stryker__.activeMutant = ${JSON.stringify(active)};`,
                }];
            },
        },
    };
}
