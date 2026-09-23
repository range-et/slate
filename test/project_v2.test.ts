import { describe, expect, it } from 'vitest';

import { createProjectV2, loadProject, parseProjectV2, ProjectFormatError } from '../vscode-extension/src/project_v2';

describe('project-v2 authority', () => {
    it('accepts strict project-v2 metadata', () => {
        const project = createProjectV2('Harness', [{ id: 'doc', path: 'src/main.py', cards: [] }]);
        project.notes.push({ id: 'note-1', title: 'Question', body: 'Why is this cached?', attachedTo: 'unit-1' });
        const result = loadProject(JSON.stringify(project));

        expect(result.migrated).toBe(false);
        expect(result.project.documents[0].path).toBe('src/main.py');
        expect(result.project.notes).toEqual(project.notes);
    });

    it('loads older v2 projects without notes and serializes an empty board', () => {
        const project = createProjectV2('Harness');
        const { notes: _notes, ...olderV2 } = project;
        expect(loadProject(JSON.stringify(olderV2)).project.notes).toEqual([]);
    });

    it('rejects escaping, absolute, non-Python, duplicate, and unknown document metadata', () => {
        const base = createProjectV2('Harness');
        for (const candidate of ['../secret.py', '/tmp/main.py', 'src/main.ts']) {
            expect(() => parseProjectV2({
                ...base,
                documents: [{ id: 'doc', path: candidate, cards: [] }],
            })).toThrow(ProjectFormatError);
        }
        expect(() => parseProjectV2({
            ...base,
            documents: [
                { id: 'one', path: 'main.py', cards: [] },
                { id: 'two', path: 'main.py', cards: [] },
            ],
        })).toThrow('duplicate document path');
        expect(() => parseProjectV2({ ...base, contextEdges: [] })).toThrow('unsupported fields');
        expect(() => parseProjectV2({
            ...base,
            notes: [
                { id: 'same', title: 'One', body: '', attachedTo: null },
                { id: 'same', title: 'Two', body: '', attachedTo: null },
            ],
        })).toThrow('note ids must be unique');
    });

    it('migrates legacy document destinations without making legacy links authoritative', () => {
        const result = loadProject(JSON.stringify({
            id: 'legacy-project',
            name: 'Legacy',
            docs: [{
                id: 'legacy-doc',
                title: 'operations',
                destination: 'src/math',
                cards: [{ id: 'add-id', title: 'add', kind: 'body', links: ['other-id'] }],
            }],
        }));

        expect(result.migrated).toBe(true);
        expect(result.project).toMatchObject({
            schemaVersion: 2,
            id: 'legacy-project',
            root: '.',
            documents: [{ path: 'src/math/operations.py', cards: [{ id: 'add-id', kind: 'function' }] }],
        });
        expect(JSON.stringify(result.project)).not.toContain('other-id');
    });

    it('salvages tracked paths from newer versions but marks them read-only', () => {
        const result = loadProject(JSON.stringify({
            schemaVersion: 3,
            id: 'future',
            name: 'Future',
            root: '.',
            documents: [{ id: 'doc', path: 'future.py', cards: [], newField: true }],
        }));
        expect(result.readOnly).toBe(true);
        expect(result.project.documents).toEqual([{ id: 'doc', path: 'future.py', cards: [] }]);
        expect(result.warnings[0]).toContain('newer than this extension');
    });
});
