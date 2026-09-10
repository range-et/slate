#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Project from '../src/project.js';
import { compileDocToPython } from '../src/code_compile.js';

const outputRoot = process.argv[2] ? resolve(process.argv[2]) : null;
if (!outputRoot) {
    console.error('usage: node scripts/compile_examples.mjs <output-directory>');
    process.exit(2);
}

const fixtures = [
    ['calculator', 'examples/calculator/calculator.slate.json'],
    ['tic_tac_toe', 'examples/tic_tac_toe/tic_tac_toe.slate.json'],
];

for (const [name, projectPath] of fixtures) {
    const project = Project.fromJSON(JSON.parse(readFileSync(projectPath, 'utf8')));
    const fixtureDir = join(outputRoot, name);
    mkdirSync(fixtureDir, { recursive: true });
    for (const doc of project.getAllDocs()) {
        const result = compileDocToPython(doc, project);
        const destination = join(fixtureDir, result.destination || '');
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, result.filename), result.source, 'utf8');
        console.log(`compiled ${name}/${result.filename}`);
    }
}
