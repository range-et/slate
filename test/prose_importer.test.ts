import { describe, expect, it } from 'vitest';

import {
    compileProse,
    parseCitationNode,
    PROSE_GENERATED_MD_HEADER,
    PROSE_GENERATED_TEX_HEADER,
} from '../vscode-extension/src/compile/prose';
import { parseFlow, serializeFlow } from '../vscode-extension/src/flow';
import {
    formatProseContract,
    parseBibtexEntries,
    portMarkdownProject,
    portProseProject,
} from '../vscode-extension/src/port/prose_importer';
import { parseProseContract, parseProseNode, verifyProseFlow } from '../vscode-extension/src/prose_adapter';
import { parseNode, serializeNode } from '../vscode-extension/src/slate_folder';

describe('Phase 8.5 (S-850): Markdown & LaTeX Prose Importer (`portProseProject` / `portMarkdownProject`)', () => {
    const sampleBib = `
@article{smith2024,
  author = {Jane Smith},
  title = {Deterministic Verification for Composable Prose Graphs},
  journal = {Journal of Automated Reasoning},
  year = {2024},
  doi = {10.1000/jar.2024.01}
}

@inproceedings{holzmann2006,
  author = {Gerard J. Holzmann},
  title = {The Power of 10: Rules for Developing Safety-Critical Code},
  booktitle = {IEEE Computer},
  year = {2006},
  doi = {10.1109/MC.2006.212}
}

@inproceedings{vaswani2017,
  author = {Ashish Vaswani et al.},
  title = {Attention Is All You Need},
  booktitle = {NeurIPS},
  year = {2017}
}
`;

    const sampleMarkdownGrant = `---
title: Safe Composable AI Grant
maxWords: 250
forbiddenTerms: [synergy, magic]
rubric: [Reproducibility, Broader Impacts]
---

# Safe Composable AI Grant

## Specific Aims
<!-- maxWords: 120 -->
We decompose complex software and scientific arguments into bounded atomic units [@smith2024] governed by strict verification rules [@holzmann2006].

## Background and Significance
<!-- minWords: 8, maxWords: 150 -->
Modern neural architectures [@vaswani2017] benefit from deterministic local contract checks [@smith2024] that guarantee **Reproducibility** across benchmarks.

## Approach and Impact
<!-- maxWords: 100 -->
Our verification pipeline enforces word budgets and citation completeness \\cite{holzmann2006} while advancing **Broader Impacts** in open science.
`;

    it('parses BibTeX entries into structured ProseCitationEntry objects', () => {
        const bibMap = parseBibtexEntries(sampleBib);
        expect(bibMap.size).toBe(3);
        expect(bibMap.get('smith2024')).toEqual({
            key: 'smith2024',
            author: 'Jane Smith',
            year: '2024',
            title: 'Deterministic Verification for Composable Prose Graphs',
            venue: 'Journal of Automated Reasoning',
            doi: '10.1000/jar.2024.01',
        });
        expect(bibMap.get('holzmann2006')?.author).toBe('Gerard J. Holzmann');
        expect(bibMap.get('vaswani2017')?.venue).toBe('NeurIPS');
    });

    it('decomposes a multi-section Markdown document + .bib into prose config, section & citation nodes, and wired flows/main.json', () => {
        expect(portMarkdownProject).toBe(portProseProject);

        const ported = portMarkdownProject({
            'grant_proposal.md': sampleMarkdownGrant,
            'references.bib': sampleBib,
        });

        expect(ported.config).toEqual({
            slate: 3,
            name: 'Safe Composable AI Grant',
            language: 'prose',
            compile: { outDir: 'build/prose' },
        });
        expect(ported.report.modules).toEqual(['grant_proposal.md']);
        expect(ported.report.warnings).toEqual([]);

        // Verify 3 section nodes + 3 citation nodes = 6 atomic nodes
        expect([...ported.nodes.keys()]).toEqual([
            'specific_aims',
            'background_and_significance',
            'approach_and_impact',
            'cite_smith2024',
            'cite_holzmann2006',
            'cite_vaswani2017',
        ]);

        // Every node must serialize and parse cleanly through slate_folder.ts
        for (const [, node] of ported.nodes) {
            const roundTrippedNode = parseNode(serializeNode(node));
            expect(roundTrippedNode.name).toBe(node.name);
            expect(roundTrippedNode.language).toBe('prose');
        }

        // Check Specific Aims node metadata & contract
        const aimsNode = ported.nodes.get('specific_aims')!;
        const parsedAims = parseProseNode(aimsNode);
        expect(parsedAims.kind).toBe('section');
        expect(parsedAims.diagnostics).toEqual([]);
        expect(parsedAims.contractSpec.maxWords).toBe(120);
        expect(parsedAims.contractSpec.requiredCitations).toEqual(['smith2024', 'holzmann2006']);
        expect(parsedAims.contractSpec.requiredSections).toEqual(['Specific Aims']);
        expect(parsedAims.contractSpec.forbiddenTerms).toEqual(['synergy', 'magic']);
        expect(aimsNode.uses).toEqual(['cite_smith2024', 'cite_holzmann2006']);

        // Check Background and Significance node metadata & contract
        const bgNode = ported.nodes.get('background_and_significance')!;
        const parsedBg = parseProseNode(bgNode);
        expect(parsedBg.contractSpec.minWords).toBe(8);
        expect(parsedBg.contractSpec.maxWords).toBe(150);
        expect(parsedBg.contractSpec.requiredCitations).toEqual(['vaswani2017', 'smith2024']);

        // Check Approach and Impact node (\cite{holzmann2006} extracted)
        const approachNode = ported.nodes.get('approach_and_impact')!;
        const parsedApproach = parseProseNode(approachNode);
        expect(parsedApproach.contractSpec.maxWords).toBe(100);
        expect(parsedApproach.contractSpec.requiredCitations).toEqual(['holzmann2006']);

        // Check Citation node
        const smithCitationNode = ported.nodes.get('cite_smith2024')!;
        expect(parseCitationNode(smithCitationNode)).toEqual({
            key: 'smith2024',
            author: 'Jane Smith',
            year: '2024',
            title: 'Deterministic Verification for Composable Prose Graphs',
            venue: 'Journal of Automated Reasoning',
            doi: '10.1000/jar.2024.01',
        });

        // Verify flows/main.json wiring and serialization
        const mainFlow = ported.mainFlow;
        expect(ported.flows.get('main')).toBe(mainFlow);
        const reparsedFlow = parseFlow(serializeFlow(mainFlow));
        expect(reparsedFlow.name).toBe('main');
        expect(reparsedFlow.outputs.map(o => o.name)).toEqual([
            'specific_aims',
            'background_and_significance',
            'approach_and_impact',
        ]);

        // Verify citation -> section wires and section -> output wires in document order
        expect(mainFlow.wires).toEqual([
            { from: 'cite_smith2024.out', to: 'specific_aims.in:cite_smith2024' },
            { from: 'cite_holzmann2006.out', to: 'specific_aims.in:cite_holzmann2006' },
            { from: 'specific_aims.out', to: 'output:specific_aims' },
            { from: 'cite_vaswani2017.out', to: 'background_and_significance.in:cite_vaswani2017' },
            { from: 'cite_smith2024.out', to: 'background_and_significance.in:cite_smith2024' },
            { from: 'background_and_significance.out', to: 'output:background_and_significance' },
            { from: 'cite_holzmann2006.out', to: 'approach_and_impact.in:cite_holzmann2006' },
            { from: 'approach_and_impact.out', to: 'output:approach_and_impact' },
        ]);

        const flowContract = parseProseContract(String(mainFlow.extra.contract ?? ''), mainFlow.extra);
        expect(flowContract.maxWords).toBe(250);
        expect(flowContract.requiredCitations).toEqual(['smith2024', 'holzmann2006', 'vaswani2017']);
        expect(flowContract.rubricCriteria).toEqual(['Reproducibility', 'Broader Impacts']);
    });

    it('round-trips a ported Markdown document through `compileProse` to both `.md` and `.tex` with zero diagnostics', () => {
        const ported = portProseProject({
            'grant_proposal.md': sampleMarkdownGrant,
            'references.bib': sampleBib,
        });

        const compiled = compileProse(ported.nodes, ported.config, ported.flows);
        expect(compiled.diagnostics).toEqual([]);
        expect(compiled.proseDiagnostics).toEqual([]);
        expect(compiled.referencedCitations).toEqual(['smith2024', 'holzmann2006', 'vaswani2017']);

        const mdOut = compiled.files.get('safe_composable_ai_grant.md')!;
        const texOut = compiled.files.get('safe_composable_ai_grant.tex')!;
        expect(mdOut).toBeDefined();
        expect(texOut).toBeDefined();

        // Verify compiled Markdown structure, resolved inline citations, and References section
        expect(mdOut).toContain(PROSE_GENERATED_MD_HEADER);
        expect(mdOut).toContain('# Safe Composable AI Grant');
        expect(mdOut).toContain('## Specific Aims');
        expect(mdOut).toContain('## Background and Significance');
        expect(mdOut).toContain('## Approach and Impact');
        expect(mdOut).toContain('(Jane Smith, 2024)');
        expect(mdOut).toContain('(Gerard J. Holzmann, 2006)');
        expect(mdOut).toContain('(Ashish Vaswani et al., 2017)');
        expect(mdOut).toContain('## References');
        expect(mdOut).toContain('**[smith2024]** Jane Smith (2024). "Deterministic Verification for Composable Prose Graphs." *Journal of Automated Reasoning*. DOI: 10.1000/jar.2024.01.');
        expect(mdOut).toContain('**[holzmann2006]** Gerard J. Holzmann (2006). "The Power of 10: Rules for Developing Safety-Critical Code." *IEEE Computer*. DOI: 10.1109/MC.2006.212.');
        expect(mdOut).toContain('**[vaswani2017]** Ashish Vaswani et al. (2017). "Attention Is All You Need." *NeurIPS*.');

        // Verify compiled LaTeX structure, \section, \cite, and \begin{thebibliography}
        expect(texOut).toContain(PROSE_GENERATED_TEX_HEADER);
        expect(texOut).toContain('\\title{Safe Composable AI Grant}');
        expect(texOut).toContain('\\section{Specific Aims}');
        expect(texOut).toContain('\\section{Background and Significance}');
        expect(texOut).toContain('\\section{Approach and Impact}');
        expect(texOut).toContain('\\cite{smith2024}');
        expect(texOut).toContain('\\cite{holzmann2006}');
        expect(texOut).toContain('\\cite{vaswani2017}');
        expect(texOut).toContain('\\textbf{Reproducibility}');
        expect(texOut).toContain('\\textbf{Broader Impacts}');
        expect(texOut).toContain('\\begin{thebibliography}');
        expect(texOut).toContain('\\bibitem{smith2024}');
        expect(texOut).toContain('\\bibitem{holzmann2006}');
        expect(texOut).toContain('\\bibitem{vaswani2017}');

        // Verify flow verification helper on assembled output
        const flowVerification = verifyProseFlow(ported.mainFlow, ported.nodes, {
            flowId: 'main',
            assembledText: compiled.assembledFlows.get('main'),
            verifyConstituentNodes: true,
        });
        expect(flowVerification.valid).toBe(true);
        expect(flowVerification.diagnostics).toEqual([]);

        // Verify re-importing the compiled `.md` back into `portProseProject` and compiling again is idempotent!
        const rePortedFromMd = portProseProject({ 'safe_composable_ai_grant.md': mdOut });
        const reCompiledFromMd = compileProse(rePortedFromMd.nodes, rePortedFromMd.config, rePortedFromMd.flows);
        expect(reCompiledFromMd.diagnostics).toEqual([]);
        expect(reCompiledFromMd.files.get('safe_composable_ai_grant.md')).toBe(mdOut);
        expect(reCompiledFromMd.files.get('safe_composable_ai_grant.tex')).toBe(texOut);

        // Verify re-importing the compiled `.tex` back into `portProseProject` and compiling again is idempotent!
        const rePortedFromTex = portProseProject({ 'safe_composable_ai_grant.tex': texOut });
        const reCompiledFromTex = compileProse(rePortedFromTex.nodes, rePortedFromTex.config, rePortedFromTex.flows);
        expect(reCompiledFromTex.diagnostics).toEqual([]);
        expect(reCompiledFromTex.files.get('safe_composable_ai_grant.md')).toBe(mdOut);
        expect(reCompiledFromTex.files.get('safe_composable_ai_grant.tex')).toBe(texOut);
    });

    it('infers word-budget metadata from frontmatter when section directives are absent and supports JSON citation maps', () => {
        const mdWithFrontmatterBudget = `---
title: Compact Abstract
maxWords: 60
minWords: 5
requiredCitations:
  - knuth1984
---

## Overview
Literate programming [@knuth1984; @lamport1994] unifies source code and human-readable exposition.
`;
        const citationsJson = JSON.stringify({
            knuth1984: {
                author: 'Donald E. Knuth',
                year: 1984,
                title: 'Literate Programming',
                venue: 'The Computer Journal',
            },
            lamport1994: {
                author: 'Leslie Lamport',
                year: '1994',
                title: 'LaTeX: A Document Preparation System',
                venue: 'Addison-Wesley',
            },
        });

        const ported = portProseProject(
            new Map([
                ['abstract.md', mdWithFrontmatterBudget],
                ['citations.json', citationsJson],
            ]),
        );

        const overviewNode = ported.nodes.get('overview')!;
        const parsedOverview = parseProseNode(overviewNode);
        expect(parsedOverview.contractSpec.maxWords).toBe(60);
        expect(parsedOverview.contractSpec.requiredCitations).toEqual(['knuth1984', 'lamport1994']);

        const compiled = compileProse(ported.nodes, ported.config, ported.flows);
        expect(compiled.diagnostics).toEqual([]);
        const md = compiled.files.get('compact_abstract.md')!;
        expect(md).toContain('(Donald E. Knuth, 1984) (Leslie Lamport, 1994)');
        expect(md).toContain('**[knuth1984]** Donald E. Knuth (1984). "Literate Programming." *The Computer Journal*.');
        expect(md).toContain('**[lamport1994]** Leslie Lamport (1994). "LaTeX: A Document Preparation System." *Addison-Wesley*.');
    });

    it('handles fallback citation synthesis, headingless passages, and empty file warnings', () => {
        const ported = portProseProject({
            'empty.md': '   \n  ',
            'notes.md': '<!-- maxWords: 50 -->\nStandalone passage citing [@ Turing1950] and [@unknown_ref] without a bib file or headings.',
        });

        expect(ported.report.warnings).toEqual(['empty.md: document is empty; not ported.']);
        expect(ported.report.modules).toEqual(['notes.md']);
        expect(ported.nodes.has('notes_passage_1')).toBe(true);
        expect(ported.nodes.has('cite_unknown_ref')).toBe(true);

        const passageNode = ported.nodes.get('notes_passage_1')!;
        const parsedPassage = parseProseNode(passageNode);
        expect(parsedPassage.kind).toBe('passage');
        expect(parsedPassage.contractSpec.maxWords).toBe(50);
        expect(parsedPassage.contractSpec.requiredCitations).toEqual(['unknown_ref']);

        const compiled = compileProse(ported.nodes, ported.config, ported.flows);
        expect(compiled.diagnostics).toEqual([]);
        expect(compiled.files.get('notes.md')).toContain('(Unknown Author, 2024)');
        expect(formatProseContract({ minWords: 10, maxWords: 50, requiredCitations: ['smith2024'] })).toBe(
            'minWords: 10, maxWords: 50, requiredCitations: [@smith2024]',
        );
    });
});
