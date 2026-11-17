import { describe, expect, it } from 'vitest';

import {
    compileProse,
    evaluateProseNode,
    parseCitationNode,
    PROSE_GENERATED_MD_HEADER,
    PROSE_GENERATED_TEX_HEADER,
    proseDocumentSlug,
    renderProseLatex,
    renderProseMarkdown,
    type ProseCitationEntry,
} from '../vscode-extension/src/compile/prose';
import { emptyFlow, parseFlow } from '../vscode-extension/src/flow';
import type { SlateFlow } from '../vscode-extension/src/harness_protocol';
import {
    countProseWords,
    extractCitations,
    extractSections,
    isProsePortType,
    normalizeCitationKey,
    normalizeProseAnnotation,
    parseProseContract,
    parseProseModule,
    parseProseNode,
    parseProseSignatureLine,
    PROSE_PORT_TYPES,
    verifyProseFlow,
    verifyProseNode,
    verifyProseText,
} from '../vscode-extension/src/prose_adapter';
import { parseConfig, parseNode, type SlateNode } from '../vscode-extension/src/slate_folder';

function makeProseNode(overrides: Partial<SlateNode> & { name: string; code: string[] }): SlateNode {
    return {
        language: 'prose',
        intent: '',
        contract: '',
        context: [],
        examples: [],
        locked: false,
        imports: [],
        uses: [],
        extra: {},
        ...overrides,
    };
}

describe('Phase 8.5 (S-850): Prose / Grant & Research Mode (`language: "prose"`)', () => {
    describe('Prose Language Adapter & Port Extraction', () => {
        it('supports structured prose port types (passage, citation, section, rubric)', () => {
            expect(PROSE_PORT_TYPES).toEqual(['passage', 'citation', 'section', 'rubric']);
            for (const portType of PROSE_PORT_TYPES) {
                expect(isProsePortType(portType)).toBe(true);
                expect(isProsePortType(portType.toUpperCase())).toBe(true);
            }
            expect(isProsePortType('int')).toBe(false);
            expect(isProsePortType(null)).toBe(false);
            expect(normalizeProseAnnotation('str')).toBe('passage');
            expect(normalizeProseAnnotation('List[citation]')).toBe('citation');
            expect(normalizeProseAnnotation(null)).toBe('passage');
        });

        it('parses `operator <name>(...) -> ...` signatures into typed input and output ports', () => {
            const node = makeProseNode({
                name: 'synthesize_aim',
                intent: 'Synthesize background claim and citation into a Specific Aims section',
                contract: 'minWords: 10, maxWords: 150, requiredCitations: [@smith2024]',
                code: [
                    'operator synthesize_aim(background: passage, key_ref: citation, criteria: rubric = "NIH Significance") -> section:',
                    '    ## Specific Aims',
                    '    {background} Grounded in prior work {key_ref} aligned with {criteria}.',
                ],
            });

            const parsed = parseProseNode(node, 'aims/synthesize_aim');
            expect(parsed.name).toBe('synthesize_aim');
            expect(parsed.kind).toBe('operator');
            expect(parsed.diagnostics).toEqual([]);
            expect(parsed.inputs).toEqual([
                { id: 'in:background', name: 'background', annotation: 'passage', optional: false },
                { id: 'in:key_ref', name: 'key_ref', annotation: 'citation', optional: false },
                { id: 'in:criteria', name: 'criteria', annotation: 'rubric', optional: true },
            ]);
            expect(parsed.outputs).toEqual([
                { id: 'out', name: 'out', annotation: 'section' },
            ]);
            expect(parsed.bodyText).toContain('## Specific Aims');
            expect(parsed.bodyText).toContain('{background} Grounded in prior work {key_ref}');
        });

        it('parses Python-style `def <name>(...) -> ...` prose operators with triple-quoted return templates', () => {
            const node = makeProseNode({
                name: 'tighten_abstract',
                code: [
                    'def tighten_abstract(draft: passage, ref: citation) -> passage:',
                    '    return f"""{draft} (validated by {ref})"""',
                ],
            });

            const parsed = parseProseNode(node);
            expect(parsed.kind).toBe('operator');
            expect(parsed.inputs).toEqual([
                { id: 'in:draft', name: 'draft', annotation: 'passage', optional: false },
                { id: 'in:ref', name: 'ref', annotation: 'citation', optional: false },
            ]);
            expect(parsed.outputs).toEqual([
                { id: 'out', name: 'out', annotation: 'passage' },
            ]);
            expect(parsed.bodyText).toBe('{draft} (validated by {ref})');
        });

        it('infers `{param}` input ports on template passage nodes without an explicit header', () => {
            const node = makeProseNode({
                name: 'evidence_paragraph',
                code: [
                    'Our preliminary experiments show {{finding}} across cohorts {cohort_ref}.',
                ],
                extra: { returnType: 'section' },
            });

            const parsed = parseProseNode(node);
            expect(parsed.kind).toBe('passage');
            expect(parsed.inputs.map(p => p.name)).toEqual(['finding', 'cohort_ref']);
            expect(parsed.outputs).toEqual([{ id: 'out', name: 'out', annotation: 'section' }]);
        });

        it('flags signature name mismatches and non-standard port type annotations', () => {
            const node = makeProseNode({
                name: 'expected_name',
                code: [
                    'operator wrong_name(count: int) -> float:',
                    '    Body text {count}',
                ],
            });

            const parsed = parseProseNode(node, 'expected_name');
            expect(parsed.diagnostics.some(d => d.code === 'prose-syntax' && d.severity === 'error')).toBe(true);
            expect(parsed.diagnostics.filter(d => d.code === 'prose-port-type')).toHaveLength(2);
        });

        it('builds a HarnessDocument-compatible ParseModuleResult via parseProseModule', () => {
            const source = [
                'operator draft_innovation(claim: passage, cite: citation) -> section:',
                '    ## Innovation',
                '    {claim} {cite}',
            ].join('\n');
            const mod = parseProseModule(source, 'slate/nodes/draft_innovation.json', 'draft_innovation');
            expect(mod.valid).toBe(true);
            expect(mod.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
            expect(mod.units).toHaveLength(1);
            expect(mod.units[0].name).toBe('draft_innovation');
            expect(mod.units[0].returnAnnotation).toBe('section');
            expect(mod.units[0].params?.map(p => p.name)).toEqual(['claim', 'cite']);
        });
    });

    describe('Deterministic Prose Verification (Word/Char Budgets, Citations, Forbidden Terms, Rubrics)', () => {
        it('enforces strict word budget (minWords and maxWords) pass and fail', () => {
            const node = makeProseNode({
                name: 'summary_box',
                contract: 'minWords: 5, maxWords: 10',
                code: [
                    'passage summary_box() -> passage:',
                    '    Deterministic composable graphs improve scientific reproducibility significantly.',
                ],
            });

            // 7 words -> passes
            const passRes = verifyProseNode(node);
            expect(passRes.valid).toBe(true);
            expect(passRes.wordCount).toBe(7);
            expect(passRes.diagnostics).toHaveLength(0);

            // Too short (3 words < 5)
            const shortRes = verifyProseNode(node, { candidateText: 'Too short text.' });
            expect(shortRes.valid).toBe(false);
            expect(shortRes.diagnostics[0].code).toBe('prose-word-budget');
            expect(shortRes.diagnostics[0].message).toContain('under minimum word budget');

            // Too long (13 words > 10)
            const longRes = verifyProseNode(node, {
                candidateText: 'One two three four five six seven eight nine ten eleven twelve thirteen.',
            });
            expect(longRes.valid).toBe(false);
            expect(longRes.diagnostics[0].code).toBe('prose-word-budget');
            expect(longRes.diagnostics[0].message).toContain('exceeds maximum word budget');
        });

        it('enforces strict character budget (minChars and maxChars) pass and fail', () => {
            const contract = parseProseContract('minChars: 20, maxChars: 60');
            expect(contract.minChars).toBe(20);
            expect(contract.maxChars).toBe(60);

            const ok = verifyProseText('This sentence has exactly thirty-eight', contract, { nodeId: 'char_node' });
            expect(ok.valid).toBe(true);
            expect(ok.charCount).toBe(38);

            const tooShort = verifyProseText('Short', contract, { nodeId: 'char_node' });
            expect(tooShort.valid).toBe(false);
            expect(tooShort.diagnostics.some(d => d.code === 'prose-char-budget')).toBe(true);

            const tooLong = verifyProseText(
                'This sentence is definitely much longer than the sixty character maximum budget allowed.',
                contract,
                { nodeId: 'char_node' },
            );
            expect(tooLong.valid).toBe(false);
            expect(tooLong.diagnostics.some(d => d.code === 'prose-char-budget')).toBe(true);
        });

        it('enforces required citations in both Markdown `[@key]` and LaTeX `\\cite{key}` syntax', () => {
            const contract = parseProseContract('requiredCitations: [@smith2024, @vaswani2017]');
            expect(contract.requiredCitations).toEqual(['smith2024', 'vaswani2017']);

            const withMdCites = verifyProseText(
                'Prior transformer architectures [@vaswani2017] and local verification [@smith2024] ground our work.',
                contract,
            );
            expect(withMdCites.valid).toBe(true);
            expect(withMdCites.citationsFound).toEqual(['vaswani2017', 'smith2024']);

            const withLatexCites = verifyProseText(
                'Prior architectures \\cite{vaswani2017, smith2024} ground our approach.',
                contract,
            );
            expect(withLatexCites.valid).toBe(true);

            const missingCite = verifyProseText(
                'Prior transformer architectures [@vaswani2017] without the second reference.',
                contract,
            );
            expect(missingCite.valid).toBe(false);
            expect(missingCite.diagnostics).toHaveLength(1);
            expect(missingCite.diagnostics[0].code).toBe('prose-missing-citation');
            expect(missingCite.diagnostics[0].message).toContain('smith2024');
        });

        it('catches forbidden terms and claims case-insensitively', () => {
            const contract = parseProseContract('forbiddenTerms: [paradigm shift, 100% guaranteed, synergy]');
            expect(contract.forbiddenTerms).toEqual(['paradigm shift', '100% guaranteed', 'synergy']);

            const clean = verifyProseText('Our empirical evaluation measures latency and accuracy.', contract);
            expect(clean.valid).toBe(true);

            const violated = verifyProseText(
                'This represents a PARADIGM SHIFT with 100% Guaranteed outcomes.',
                contract,
            );
            expect(violated.valid).toBe(false);
            expect(violated.diagnostics.filter(d => d.code === 'prose-forbidden-term')).toHaveLength(2);
        });

        it('verifies grant/research rubric completeness and required sections', () => {
            const contract = parseProseContract(
                'requiredSections: [Specific Aims, Significance, Innovation] rubric: [Approach, Reproducibility, Broader Impacts]',
            );
            expect(contract.requiredSections).toEqual(['Specific Aims', 'Significance', 'Innovation']);
            expect(contract.rubricCriteria).toEqual(['Approach', 'Reproducibility', 'Broader Impacts']);

            const completeGrant = [
                '## Specific Aims',
                'We define our technical Approach and Reproducibility protocol.',
                '## Significance',
                'This addresses critical barriers and delivers Broader Impacts.',
                '## Innovation',
                'Bounded atomic verification.',
            ].join('\n');

            const passRes = verifyProseText(completeGrant, contract, { flowId: 'grant_proposal' });
            expect(passRes.valid).toBe(true);
            expect(passRes.sectionsFound).toEqual(['Specific Aims', 'Significance', 'Innovation']);

            const incompleteGrant = [
                '## Specific Aims',
                'We define our technical Approach.',
                '## Significance',
                'This addresses critical barriers.',
            ].join('\n');

            const failRes = verifyProseText(incompleteGrant, contract, { flowId: 'grant_proposal' });
            expect(failRes.valid).toBe(false);
            expect(failRes.diagnostics.some(d => d.code === 'prose-missing-section' && d.message.includes('Innovation'))).toBe(true);
            expect(failRes.diagnostics.some(d => d.code === 'prose-rubric-incomplete' && d.message.includes('Reproducibility'))).toBe(true);
            expect(failRes.diagnostics.some(d => d.code === 'prose-rubric-incomplete' && d.message.includes('Broader Impacts'))).toBe(true);
        });

        it('supports JSON-formatted contract strings and extra.proseContract metadata', () => {
            const jsonContract = parseProseContract(
                JSON.stringify({
                    minWords: 3,
                    maxWords: 20,
                    requiredCitations: ['@holzmann2006'],
                    forbiddenTerms: ['magic'],
                }),
            );
            expect(jsonContract.minWords).toBe(3);
            expect(jsonContract.maxWords).toBe(20);
            expect(jsonContract.requiredCitations).toEqual(['holzmann2006']);
            expect(jsonContract.forbiddenTerms).toEqual(['magic']);

            const rangeContract = parseProseContract('Word budget: 10..50 words; <= 500 chars');
            expect(rangeContract.minWords).toBe(10);
            expect(rangeContract.maxWords).toBe(50);
            expect(rangeContract.maxChars).toBe(500);
        });
    });

    describe('End-to-End Deterministic Prose Compilation (Markdown & LaTeX + Citations)', () => {
        const config = parseConfig(
            JSON.stringify({
                slate: 3,
                name: 'NSF Safe AI Grant',
                language: 'prose',
                compile: { outDir: 'build/prose' },
            }),
        );

        const citeHolzmann = parseNode(
            JSON.stringify({
                slate: 3,
                name: 'cite_holzmann',
                language: 'prose',
                intent: 'NASA JPL Power of 10 safety-critical coding rules',
                contract: '',
                locked: false,
                code: [
                    'citation cite_holzmann() -> citation:',
                    '    key: holzmann2006',
                    '    author: Gerard J. Holzmann',
                    '    year: 2006',
                    '    title: The Power of 10: Rules for Developing Safety-Critical Code',
                    '    venue: IEEE Computer',
                    '    doi: 10.1109/MC.2006.212',
                ],
            }),
        );

        const citeVaswani = parseNode(
            JSON.stringify({
                slate: 3,
                name: 'cite_vaswani',
                language: 'prose',
                intent: 'Transformer architecture reference',
                contract: '',
                locked: false,
                code: [
                    'citation cite_vaswani() -> citation:',
                    '    {"key": "vaswani2017", "author": "Ashish Vaswani et al.", "year": "2017", "title": "Attention Is All You Need", "venue": "NeurIPS"}',
                ],
            }),
        );

        const claimPassage = parseNode(
            JSON.stringify({
                slate: 3,
                name: 'core_hypothesis',
                language: 'prose',
                intent: 'State core hypothesis on bounded atomic software synthesis',
                contract: 'minWords: 8, maxWords: 40, forbiddenTerms: [unverified]',
                locked: false,
                code: [
                    'passage core_hypothesis() -> passage:',
                    '    Decomposing software into bounded atomic units under sixty lines enables deterministic verification and mutation testing.',
                ],
            }),
        );

        const aimsSection = parseNode(
            JSON.stringify({
                slate: 3,
                name: 'aims_section',
                language: 'prose',
                intent: 'Format Specific Aims section combining hypothesis and foundational citations',
                contract: 'requiredCitations: [@holzmann2006, @vaswani2017], requiredSections: [Specific Aims]',
                locked: false,
                code: [
                    'operator aims_section(hypothesis: passage, safety_ref: citation, model_ref: citation) -> section:',
                    '    ## Specific Aims',
                    '    {hypothesis} Building on safety-critical engineering rules {safety_ref} and modern neural architectures {model_ref}, we verify each component.',
                ],
            }),
        );

        const significanceSection = parseNode(
            JSON.stringify({
                slate: 3,
                name: 'significance_section',
                language: 'prose',
                intent: 'Format Significance and Innovation section with rubric criteria',
                contract: 'requiredSections: [Significance and Innovation], rubric: [Reproducibility, Broader Impacts]',
                locked: false,
                code: [
                    'operator significance_section(impact_note: passage) -> section:',
                    '    ## Significance and Innovation',
                    '    Our **Reproducibility** pipeline and **Broader Impacts** plan ensure transparent open-science artifacts. {impact_note}',
                ],
            }),
        );

        const combineGrant = parseNode(
            JSON.stringify({
                slate: 3,
                name: 'assemble_proposal',
                language: 'prose',
                intent: 'Combine sections into full grant narrative',
                contract: 'minWords: 25, maxWords: 120',
                locked: false,
                code: [
                    'operator assemble_proposal(sec_aims: section, sec_sig: section) -> section:',
                    '    {sec_aims}',
                    '',
                    '    {sec_sig}',
                ],
            }),
        );

        const nodes = new Map<string, SlateNode>([
            ['cite_holzmann', citeHolzmann],
            ['cite_vaswani', citeVaswani],
            ['core_hypothesis', claimPassage],
            ['aims_section', aimsSection],
            ['significance_section', significanceSection],
            ['assemble_proposal', combineGrant],
        ]);

        const mainFlow = parseFlow(
            JSON.stringify({
                slate: 3,
                name: 'main',
                inputs: [],
                outputs: [{ name: 'proposal', annotation: 'section' }],
                instances: [
                    { id: 'c_holz', node: 'cite_holzmann' },
                    { id: 'c_vas', node: 'cite_vaswani' },
                    { id: 'hyp', node: 'core_hypothesis' },
                    { id: 'impact_val', kind: 'value', value: 'All benchmarks are publicly archived.' },
                    { id: 'aims', node: 'aims_section' },
                    { id: 'sig', node: 'significance_section' },
                    { id: 'full', node: 'assemble_proposal' },
                ],
                wires: [
                    { from: 'hyp.out', to: 'aims.in:hypothesis' },
                    { from: 'c_holz.out', to: 'aims.in:safety_ref' },
                    { from: 'c_vas.out', to: 'aims.in:model_ref' },
                    { from: 'impact_val.out', to: 'sig.in:impact_note' },
                    { from: 'aims.out', to: 'full.in:sec_aims' },
                    { from: 'sig.out', to: 'full.in:sec_sig' },
                    { from: 'full.out', to: 'output:proposal' },
                ],
                contract: 'requiredSections: [Specific Aims, Significance and Innovation], requiredCitations: [@holzmann2006, @vaswani2017]',
            }),
        );

        it('compiles a wired multi-node grant flow into Markdown and LaTeX with resolved citations and bibliography', () => {
            const flows = new Map<string, SlateFlow>([['main', mainFlow]]);
            const result = compileProse(nodes, config, flows);

            expect(result.diagnostics).toEqual([]);
            expect(result.proseDiagnostics).toEqual([]);
            expect(result.referencedCitations).toEqual(['holzmann2006', 'vaswani2017']);

            const mdPath = 'nsf_safe_ai_grant.md';
            const texPath = 'nsf_safe_ai_grant.tex';
            expect([...result.files.keys()]).toEqual([mdPath, texPath]);

            const md = result.files.get(mdPath)!;
            expect(md).toContain(PROSE_GENERATED_MD_HEADER);
            expect(md).toContain('# NSF Safe AI Grant');
            expect(md).toContain('## Specific Aims');
            expect(md).toContain('## Significance and Innovation');
            // Inline citations resolved to (Author, Year) in Markdown
            expect(md).toContain('(Gerard J. Holzmann, 2006)');
            expect(md).toContain('(Ashish Vaswani et al., 2017)');
            // Assembled References section
            expect(md).toContain('## References');
            expect(md).toContain('**[holzmann2006]** Gerard J. Holzmann (2006). "The Power of 10: Rules for Developing Safety-Critical Code." *IEEE Computer*. DOI: 10.1109/MC.2006.212.');
            expect(md).toContain('**[vaswani2017]** Ashish Vaswani et al. (2017). "Attention Is All You Need." *NeurIPS*.');

            const tex = result.files.get(texPath)!;
            expect(tex).toContain(PROSE_GENERATED_TEX_HEADER);
            expect(tex).toContain('\\documentclass[11pt]{article}');
            expect(tex).toContain('\\title{NSF Safe AI Grant}');
            expect(tex).toContain('\\section{Specific Aims}');
            expect(tex).toContain('\\section{Significance and Innovation}');
            expect(tex).toContain('\\cite{holzmann2006}');
            expect(tex).toContain('\\cite{vaswani2017}');
            expect(tex).toContain('\\textbf{Reproducibility}');
            expect(tex).toContain('\\begin{thebibliography}');
            expect(tex).toContain('\\bibitem{holzmann2006} Gerard J. Holzmann (2006). The Power of 10: Rules for Developing Safety-Critical Code.');
            expect(tex).toContain('\\bibitem{vaswani2017} Ashish Vaswani et al. (2017). Attention Is All You Need.');
        });

        it('supports control-flow regions (branch, foreach, repeat) in prose flows', () => {
            const formatBullet = makeProseNode({
                name: 'format_evidence',
                code: [
                    'operator format_evidence(item: passage) -> passage:',
                    '    - Evidence item: {item}',
                ],
            });
            const shortSummary = makeProseNode({
                name: 'short_summary',
                code: [
                    'passage short_summary(topic: passage) -> passage:',
                    '    Concise summary on {topic}.',
                ],
            });
            const detailedSummary = makeProseNode({
                name: 'detailed_summary',
                code: [
                    'passage detailed_summary(topic: passage) -> passage:',
                    '    Comprehensive analysis of {topic}.',
                ],
            });

            const foreachBody: SlateFlow = {
                ...emptyFlow('bullet_body'),
                inputs: [{ name: 'item', annotation: 'passage' }],
                outputs: [{ name: 'bullet', annotation: 'passage' }],
                instances: [{ id: 'fmt', node: 'format_evidence' }],
                wires: [
                    { from: 'input:item', to: 'fmt.in:item' },
                    { from: 'fmt.out', to: 'output:bullet' },
                ],
            };

            const thenFlow: SlateFlow = {
                ...emptyFlow('then_branch'),
                inputs: [{ name: 'topic', annotation: 'passage' }],
                outputs: [{ name: 'summary', annotation: 'passage' }],
                instances: [{ id: 's', node: 'short_summary' }],
                wires: [
                    { from: 'input:topic', to: 's.in:topic' },
                    { from: 's.out', to: 'output:summary' },
                ],
            };

            const elseFlow: SlateFlow = {
                ...emptyFlow('else_branch'),
                inputs: [{ name: 'topic', annotation: 'passage' }],
                outputs: [{ name: 'summary', annotation: 'passage' }],
                instances: [{ id: 'd', node: 'detailed_summary' }],
                wires: [
                    { from: 'input:topic', to: 'd.in:topic' },
                    { from: 'd.out', to: 'output:summary' },
                ],
            };

            const parentFlow: SlateFlow = {
                ...emptyFlow('research_report'),
                inputs: [],
                outputs: [
                    { name: 'header', annotation: 'passage' },
                    { name: 'bullets', annotation: 'passage' },
                ],
                instances: [
                    { id: 'cond', kind: 'value', value: false },
                    { id: 'topic_val', kind: 'value', value: 'fault tolerance' },
                    { id: 'items_val', kind: 'value', value: '["Trial A", "Trial B"]' },
                ],
                regions: [
                    {
                        id: 'choose_summary',
                        kind: 'branch',
                        conditionPort: 'condition',
                        thenFlow: 'then_branch',
                        elseFlow: 'else_branch',
                    },
                    {
                        id: 'list_evidence',
                        kind: 'foreach',
                        bodyFlow: 'bullet_body',
                        collectionPort: 'items',
                        itemPort: 'item',
                    },
                ],
                wires: [
                    { from: 'cond.out', to: 'choose_summary.in:condition' },
                    { from: 'topic_val.out', to: 'choose_summary.in:topic' },
                    { from: 'items_val.out', to: 'list_evidence.in:items' },
                    { from: 'choose_summary.out', to: 'output:header' },
                    { from: 'list_evidence.out', to: 'output:bullets' },
                ],
            };

            const regionNodes = new Map<string, SlateNode>([
                ['format_evidence', formatBullet],
                ['short_summary', shortSummary],
                ['detailed_summary', detailedSummary],
            ]);
            const regionFlows = new Map<string, SlateFlow>([
                ['bullet_body', foreachBody],
                ['then_branch', thenFlow],
                ['else_branch', elseFlow],
                ['research_report', parentFlow],
            ]);

            const compiled = compileProse(regionNodes, config, regionFlows);
            expect(compiled.diagnostics).toEqual([]);
            const assembled = compiled.assembledFlows.get('research_report')!;
            expect(assembled).toContain('Comprehensive analysis of fault tolerance.');
            expect(assembled).not.toContain('Concise summary');
            expect(assembled).toContain('- Evidence item: Trial A');
            expect(assembled).toContain('- Evidence item: Trial B');
        });
    });

    describe('Boundary, Invalid Input, and Cyclic / Missing Wire Diagnostic Paths', () => {
        const config = parseConfig(
            JSON.stringify({
                slate: 3,
                name: 'DiagTest',
                language: 'prose',
            }),
        );

        it('reports cycle diagnostics when prose flow instances form a dependency loop', () => {
            const opA = makeProseNode({
                name: 'step_a',
                code: ['operator step_a(inp: passage) -> passage:', '    A({inp})'],
            });
            const opB = makeProseNode({
                name: 'step_b',
                code: ['operator step_b(inp: passage) -> passage:', '    B({inp})'],
            });
            const cyclicFlow: SlateFlow = {
                ...emptyFlow('cyclic_doc'),
                outputs: [{ name: 'out', annotation: 'passage' }],
                instances: [
                    { id: 'a', node: 'step_a' },
                    { id: 'b', node: 'step_b' },
                ],
                wires: [
                    { from: 'a.out', to: 'b.in:inp' },
                    { from: 'b.out', to: 'a.in:inp' },
                    { from: 'b.out', to: 'output:out' },
                ],
            };

            const res = compileProse(
                new Map([
                    ['step_a', opA],
                    ['step_b', opB],
                ]),
                config,
                new Map([['cyclic_doc', cyclicFlow]]),
            );

            expect(res.proseDiagnostics.some(d => d.code === 'prose-flow-cycle')).toBe(true);
            expect(res.diagnostics.some(d => d.severity === 'error' && d.message.includes('form a cycle'))).toBe(true);
        });

        it('reports missing nodes, unwired required inputs, unknown endpoints, and unresolved citations', () => {
            const opNeedsInput = makeProseNode({
                name: 'needs_input',
                code: [
                    'operator needs_input(required_arg: passage) -> passage:',
                    '    Text with [@unknown_ref_2099] and {required_arg}',
                ],
            });

            const brokenFlow: SlateFlow = {
                ...emptyFlow('broken_flow'),
                outputs: [{ name: 'unwired_out', annotation: 'passage' }],
                instances: [
                    { id: 'missing_inst', node: 'non_existent_node' },
                    { id: 'incomplete_inst', node: 'needs_input' },
                ],
                wires: [
                    { from: 'ghost.out', to: 'incomplete_inst.in:required_arg' },
                ],
            };

            const flowCheck = verifyProseFlow(brokenFlow, new Map([['needs_input', opNeedsInput]]), {
                flowId: 'broken_flow',
                verifyConstituentNodes: true,
            });
            expect(flowCheck.valid).toBe(false);
            expect(flowCheck.diagnostics.some(d => d.code === 'prose-wire-error' && d.message.includes('non_existent_node'))).toBe(true);
            expect(flowCheck.diagnostics.some(d => d.code === 'prose-wire-error' && d.message.includes('ghost'))).toBe(true);

            const compiled = compileProse(
                new Map([['needs_input', opNeedsInput]]),
                config,
                new Map([['broken_flow', brokenFlow]]),
            );
            expect(compiled.proseDiagnostics.some(d => d.message.includes('does not exist'))).toBe(true);
            expect(compiled.proseDiagnostics.some(d => d.message.includes('is not wired and has no default'))).toBe(true);
            expect(compiled.proseDiagnostics.some(d => d.message.includes('output unwired_out is not wired'))).toBe(true);
            expect(compiled.proseDiagnostics.some(d => d.code === 'prose-missing-citation' && d.message.includes('unknown_ref_2099'))).toBe(true);
        });

        it('handles empty prose nodes, non-prose language diagnostics, and standalone node fallback assembly', () => {
            const emptyNode = makeProseNode({
                name: 'empty_passage',
                intent: 'Fallback intent text when body is empty',
                code: [],
            });
            const pythonNode: SlateNode = {
                ...makeProseNode({ name: 'py_fn', code: ['def py_fn(x: int) -> int:', '    return x'] }),
                language: 'python',
            };

            expect(countProseWords('   <!-- comment only -->   ')).toBe(0);
            expect(extractCitations('No citations here [plain bracket]')).toEqual([]);
            expect(extractSections('Plain line without headings')).toEqual([]);
            expect(normalizeCitationKey('\\cite{knuth1984}')).toBe('knuth1984');
            expect(proseDocumentSlug('  ***  ')).toBe('document');

            const evaluatedEmpty = evaluateProseNode(emptyNode, {}, new Map());
            expect(evaluatedEmpty).toBe('Fallback intent text when body is empty');

            const explicitCitations: ProseCitationEntry[] = [
                { key: '@knuth1984', author: 'Donald E. Knuth', year: '1984', title: 'Literate Programming' },
            ];
            const res = compileProse(
                new Map([
                    ['empty_passage', emptyNode],
                    ['py_fn', pythonNode],
                ]),
                config,
                new Map(),
                explicitCitations,
            );

            expect(res.proseDiagnostics.some(d => d.code === 'prose-syntax' && d.nodeId === 'py_fn')).toBe(true);
            expect(res.files.has('diagtest.md')).toBe(true);
            expect(res.files.has('diagtest.tex')).toBe(true);

            // Also verify direct rendering helpers with unresolved citation keys
            const mdUnresolved = renderProseMarkdown('Title', 'Cite [@missingKey].', new Map(), ['missingKey']);
            expect(mdUnresolved).toContain('Unresolved citation key `missingKey`');
            const texUnresolved = renderProseLatex('Title', '### Subheading\n#### Subsub\n*italic* [@missingKey]', new Map(), ['missingKey']);
            expect(texUnresolved).toContain('\\subsection{Subheading}');
            expect(texUnresolved).toContain('\\subsubsection{Subsub}');
            expect(texUnresolved).toContain('\\textit{italic}');
            expect(texUnresolved).toContain('\\bibitem{missingKey} Unresolved citation missingKey.');
        });
    });
});
