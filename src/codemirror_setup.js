import { EditorView, keymap, Decoration, ViewPlugin } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { python } from "@codemirror/lang-python";

/**
 * Custom theme for the editor
 */
// Editor chrome only. Autocomplete tooltip styling lives in styles.css under
// `/* ---------- CodeMirror autocomplete (monad themed) ----------*/`
// because CM portals the tooltip outside the editor's scope, where
// EditorView.theme styles get out-prioritized by CM defaults.
const customTheme = EditorView.theme({
    "&": {
        backgroundColor: "var(--background)",
        color: "var(--primary-text)",
        fontSize: "var(--type-sm, 13px)",
        fontFamily: "inherit",
        height: "100%",
        width: "100%"
    },
    ".cm-scroller": {
        overflow: "auto",
        height: "100%",
        fontFamily: "var(--font-mono, 'Courier New', monospace)",
        lineHeight: "1.5"
    },
    ".cm-content": {
        caretColor: "var(--primary-text)",
        padding: "8px",
        minHeight: "100%"
    },
    "&.cm-focused": {
        outline: "none"
    },
    ".cm-line": {
        padding: "0"
    },
    ".cm-cursor": {
        borderLeftColor: "var(--primary-text)"
    },
    ".cm-selectionBackground": {
        backgroundColor: "var(--information-2) !important",
        opacity: "0.3"
    },
    "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "var(--information-2) !important",
        opacity: "0.3"
    },
    ".cm-reference": {
        color: "var(--strata-info)",
        fontWeight: "500",
        fontFamily: "var(--font-mono)"
    }
});

/**
 * Decoration for @references
 */
const referenceMark = Decoration.mark({ class: "cm-reference" });

/**
 * ViewPlugin to highlight @references
 */
const referenceHighlighter = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = this.buildDecorations(view);
    }
    
    update(update) {
        if (update.docChanged || update.viewportChanged) {
            this.decorations = this.buildDecorations(update.view);
        }
    }
    
    buildDecorations(view) {
        const decorations = [];
        const text = view.state.doc.toString();
        const regex = /@[\w]+/g;
        let match;
        
        while ((match = regex.exec(text)) !== null) {
            const from = match.index;
            const to = match.index + match[0].length;
            decorations.push(referenceMark.range(from, to));
        }
        
        return Decoration.set(decorations);
    }
}, {
    decorations: v => v.decorations
});

/**
 * Create autocomplete function
 */
function createReferenceCompletion(getCurrentDoc, getCurrentProject) {
    return (context) => {
        // Check if we're after an @ symbol
        const word = context.matchBefore(/@[\w]*/);
        if (!word) return null;
        
        // Don't show completions if there's no @ at the start
        if (word.from === word.to && !context.explicit) return null;
        
        // Get all available references (cards and docs) - PROJECT-WIDE
        const options = [];
        
        try {
            const currentProject = getCurrentProject();
            
            if (currentProject) {
                // Get ALL cards from ALL documents in the project
                currentProject.getAllDocs().forEach(doc => {
                    doc.getAllCards().forEach(card => {
                        options.push({
                            label: "@" + card.title,
                            apply: "@" + card.title + " ",
                            type: "variable",
                            detail: `🟢 card (${doc.title})`,  // Show which doc the card is from
                            info: `Card: ${card.title} from document "${doc.title}"`,
                            section: "Cards"
                        });
                    });
                });
                
                // Get all documents
                currentProject.getAllDocs().forEach(doc => {
                    options.push({
                        label: "@" + doc.title,
                        apply: "@" + doc.title + " ",
                        type: "class",
                        detail: "🔵 doc",
                        info: `Document: ${doc.title}`,
                        section: "Documents"
                    });
                });
            }
        } catch (err) {
            console.warn("Error getting completions:", err);
        }
        
        return {
            from: word.from,
            options: options,
            validFor: /@[\w]*/
        };
    };
}

/**
 * Setup CodeMirror editor with @reference support.
 * Returns the EditorView with a `setLanguage(name)` helper that swaps between
 * 'plain' and 'python' at runtime via a Compartment.
 */
export function setupCodeMirrorEditor(container, getCurrentDoc, getCurrentProject, options = {}) {
    const completionSource = createReferenceCompletion(getCurrentDoc, getCurrentProject);
    const languageCompartment = new Compartment();
    const initialLanguage = options.language === 'python' ? 'python' : 'plain';
    const languageExtensionFor = name => (name === 'python' ? [python(), syntaxHighlighting(defaultHighlightStyle)] : []);

    const state = EditorState.create({
        doc: "",
        extensions: [
            keymap.of([
                ...defaultKeymap,
                {
                    key: "Enter",
                    run: () => false  // let the form handle Enter
                }
            ]),
            customTheme,
            referenceHighlighter,
            autocompletion({
                override: [completionSource],
                activateOnTyping: true,
                closeOnBlur: true,
                defaultKeymap: true
            }),
            EditorView.lineWrapping,
            languageCompartment.of(languageExtensionFor(initialLanguage))
        ]
    });

    const view = new EditorView({
        state,
        parent: container
    });

    view.setLanguage = name => {
        view.dispatch({
            effects: languageCompartment.reconfigure(languageExtensionFor(name === 'python' ? 'python' : 'plain'))
        });
    };

    return view;
}

/**
 * Get text content from editor
 */
export function getEditorText(editorView) {
    return editorView.state.doc.toString();
}

/**
 * Set text content in editor
 */
export function setEditorText(editorView, text) {
    editorView.dispatch({
        changes: {
            from: 0,
            to: editorView.state.doc.length,
            insert: text
        }
    });
}

/**
 * Clear editor content
 */
export function clearEditor(editorView) {
    setEditorText(editorView, "");
}

/**
 * Insert text at cursor position
 */
export function insertAtCursor(editorView, text) {
    const selection = editorView.state.selection.main;
    editorView.dispatch({
        changes: {
            from: selection.from,
            to: selection.to,
            insert: text
        },
        selection: {
            anchor: selection.from + text.length
        }
    });
    editorView.focus();
}

