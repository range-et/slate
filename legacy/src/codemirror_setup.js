import { EditorView, keymap, Decoration, ViewPlugin } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t, highlightTree } from "@lezer/highlight";

/**
 * Monad-flavored syntax theme. Pulls from the design tokens used elsewhere
 * in the app so code colors don't clash with the rest of the UI:
 *   - strata-info       (cyan)   → keywords, class names, types
 *   - strata-warning    (amber)  → strings, regex, atoms
 *   - strata-success    (green)  → numbers, booleans, null/None
 *   - strata-highlight  (yellow) → markdown headings, link text
 *   - text-secondary            → comments, punctuation, operators
 *   - text-primary              → identifiers, default
 *
 * Used by both the editor (via syntaxHighlighting()) and by
 * highlightCodeStatic() so rendered cards match the editor exactly.
 */
export const monadHighlightStyle = HighlightStyle.define([
    // Comments — dimmed + italic
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: "var(--strata-text-secondary, #888)", fontStyle: "italic", opacity: 0.85 },

    // Keywords (def, class, import, if, return, …)
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword,
            t.definitionKeyword, t.modifier, t.self],
      color: "var(--strata-info, #2B9ED1)", fontWeight: "500" },

    // Strings, regex
    { tag: [t.string, t.special(t.string), t.regexp],
      color: "var(--strata-warning, #D7A12A)" },
    { tag: t.escape, color: "var(--strata-warning, #D7A12A)", fontWeight: "600" },

    // Numbers, booleans, null/None
    { tag: [t.number, t.bool, t.null, t.atom],
      color: "var(--strata-success, #6EAD45)" },

    // Function/method declarations
    { tag: [t.function(t.variableName), t.function(t.definition(t.variableName))],
      color: "var(--strata-text-primary, #fff)", fontWeight: "600" },

    // Class/type names
    { tag: [t.className, t.typeName, t.namespace, t.definition(t.typeName)],
      color: "var(--strata-info, #2B9ED1)", fontWeight: "600" },

    // Variables, properties, identifiers — default text
    { tag: [t.variableName, t.propertyName, t.attributeName],
      color: "var(--strata-text-primary, #fff)" },
    { tag: t.special(t.variableName),
      color: "var(--strata-info, #2B9ED1)", fontStyle: "italic" },

    // Operators, punctuation, brackets — dimmed
    { tag: [t.operator, t.punctuation, t.bracket, t.paren, t.brace, t.squareBracket],
      color: "var(--strata-text-secondary, #888)" },

    // ─── Markdown ───
    { tag: t.heading,        color: "var(--strata-highlight, #FFEB3B)", fontWeight: "700" },
    { tag: t.heading1,       color: "var(--strata-highlight, #FFEB3B)", fontWeight: "700", fontSize: "1.15em" },
    { tag: t.heading2,       color: "var(--strata-highlight, #FFEB3B)", fontWeight: "700" },
    { tag: t.heading3,       color: "var(--strata-info, #2B9ED1)",      fontWeight: "600" },
    { tag: t.heading4,       color: "var(--strata-info, #2B9ED1)",      fontWeight: "500" },
    { tag: t.emphasis,       fontStyle: "italic" },
    { tag: t.strong,         fontWeight: "700", color: "var(--strata-text-primary, #fff)" },
    { tag: t.strikethrough,  textDecoration: "line-through", opacity: 0.7 },
    { tag: t.link,           color: "var(--strata-info, #2B9ED1)", textDecoration: "underline" },
    { tag: t.url,            color: "var(--strata-info, #2B9ED1)" },
    { tag: t.monospace,      fontFamily: "var(--font-mono, monospace)",
                             color: "var(--strata-warning, #D7A12A)" },
    { tag: t.list,           color: "var(--strata-warning, #D7A12A)" },
    { tag: t.quote,          color: "var(--strata-text-secondary, #888)", fontStyle: "italic" },
    { tag: t.contentSeparator, color: "var(--strata-text-secondary, #888)" },

    // Misc
    { tag: t.invalid,        color: "var(--strata-warning, #D7A12A)",
                             textDecoration: "underline wavy var(--strata-warning, #D7A12A)" },
    { tag: t.meta,           color: "var(--strata-text-secondary, #888)" },
]);

/**
 * Static syntax highlighter for rendered code (e.g. inside cards). Returns
 * an HTML string with `<span class="..." style="...">` tags so it matches
 * the editor exactly without instantiating an EditorView per card.
 *
 * @param {string} source       Raw source code
 * @param {'python'|'markdown'} language  Language to parse as
 * @returns {string} HTML-escaped, syntax-highlighted output (no surrounding <pre>).
 */
export function highlightCodeStatic(source, language = 'python') {
    if (!source) return "";
    const lang = language === 'markdown' ? markdownLanguage : pythonLanguage;
    const tree = lang.parser.parse(source);
    let html = "";
    let pos = 0;
    const escape = s => s
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    highlightTree(tree, monadHighlightStyle, (from, to, classes) => {
        if (from > pos) html += escape(source.slice(pos, from));
        html += `<span class="${classes}">${escape(source.slice(from, to))}</span>`;
        pos = to;
    });
    if (pos < source.length) html += escape(source.slice(pos));
    return html;
}

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
 * Setup CodeMirror editor with @reference support and language-aware syntax
 * highlighting. Returns the EditorView with a `setLanguage(name)` helper that
 * swaps between 'plain', 'python', and 'markdown' at runtime via a Compartment.
 *
 * The monad-flavored syntax style ships with both 'python' and 'markdown' so
 * the colors match the rest of the slate UI rather than CM's default palette.
 *
 * @param {Object} options
 * @param {'plain'|'python'|'markdown'} [options.language='plain']  Initial mode.
 * @param {boolean} [options.readOnly=false]  For card-rendered editors.
 */
export function setupCodeMirrorEditor(container, getCurrentDoc, getCurrentProject, options = {}) {
    const completionSource = createReferenceCompletion(getCurrentDoc, getCurrentProject);
    const languageCompartment = new Compartment();
    const initialLanguage = ['python', 'markdown'].includes(options.language) ? options.language : 'plain';

    const languageExtensionFor = name => {
        if (name === 'python') return [python(), syntaxHighlighting(monadHighlightStyle)];
        if (name === 'markdown') return [markdown({ codeLanguages: [{ name: 'python', support: python() }] }),
                                          syntaxHighlighting(monadHighlightStyle)];
        return [syntaxHighlighting(monadHighlightStyle)];  // plain → still apply md heading colors etc. via tags that match
    };

    const extensions = [
        keymap.of([
            ...defaultKeymap,
            { key: "Enter", run: () => false }  // let the form handle Enter
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
    ];

    if (options.readOnly) {
        extensions.push(EditorState.readOnly.of(true));
        extensions.push(EditorView.editable.of(false));
    }

    const state = EditorState.create({ doc: "", extensions });
    const view = new EditorView({ state, parent: container });

    view.setLanguage = name => {
        const target = ['python', 'markdown'].includes(name) ? name : 'plain';
        view.dispatch({
            effects: languageCompartment.reconfigure(languageExtensionFor(target))
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

