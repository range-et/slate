import { EditorView, keymap, Decoration, ViewPlugin } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";

/**
 * Custom theme for the editor
 */
const customTheme = EditorView.theme({
    "&": {
        backgroundColor: "var(--background)",
        color: "var(--primary-text)",
        fontSize: "medium",
        fontFamily: "inherit",
        height: "100%",
        width: "100%"
    },
    ".cm-scroller": {
        overflow: "auto",
        height: "100%"
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
    ".cm-tooltip-autocomplete": {
        backgroundColor: "var(--background)",
        border: "1px solid var(--information-2)",
        borderRadius: "4px",
        boxShadow: "0 4px 8px rgba(0,0,0,0.3)",
        "& ul": {
            fontFamily: "inherit",
            maxHeight: "300px",
            overflowY: "auto"
        },
        "& li": {
            color: "var(--primary-text)",
            padding: "6px 10px",
            cursor: "pointer",
            borderRadius: "2px"
        },
        "& li[aria-selected]": {
            backgroundColor: "#03A9F4",  // information-2 (light blue)
            color: "#1A1A1A"  // Dark background for contrast
        }
    },
    // Info panel that shows additional details
    ".cm-tooltip.cm-tooltip-autocomplete.cm-completionInfo": {
        backgroundColor: "var(--background)",
        border: "1px solid var(--information-2)",
        color: "var(--primary-text)",
        padding: "8px 12px",
        boxShadow: "0 4px 8px rgba(0,0,0,0.3)"
    },
    ".cm-completionInfo": {
        backgroundColor: "var(--background)",
        color: "var(--primary-text)",
        padding: "8px 12px"
    },
    // Completion item styling - matching network viz colors
    ".cm-completionLabel": {
        fontWeight: "500",
        color: "var(--primary-text)"
    },
    ".cm-completionDetail": {
        fontStyle: "normal",
        fontSize: "0.85em",
        marginLeft: "auto",
        paddingLeft: "12px",
        fontWeight: "600"
    },
    // Section headers in completion list
    "ul[role=listbox] li[role=option][aria-disabled=true]": {
        padding: "4px 10px 2px",
        fontSize: "0.75em",
        fontWeight: "700",
        textTransform: "uppercase",
        color: "var(--information-2)",
        opacity: "0.8",
        cursor: "default",
        backgroundColor: "transparent !important"
    },
    ".cm-reference": {
        color: "#00BCD4",
        fontWeight: "500"
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
        
        // Get all available references (cards and docs)
        const options = [];
        
        try {
            // Get current doc cards
            const currentDoc = getCurrentDoc();
            if (currentDoc) {
                currentDoc.getAllCards().forEach(card => {
                    options.push({
                        label: "@" + card.title,
                        apply: "@" + card.title + " ",
                        type: "variable",
                        detail: "🟢 card",  // Green circle emoji to match card color
                        info: `Card: ${card.title}`,
                        section: "Cards"
                    });
                });
            }
            
            // Get all docs
            const currentProject = getCurrentProject();
            if (currentProject) {
                currentProject.getAllDocs().forEach(doc => {
                    options.push({
                        label: "@" + doc.title,
                        apply: "@" + doc.title + " ",
                        type: "class",
                        detail: "🔵 doc",  // Blue circle emoji to match doc color
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
 * Setup CodeMirror editor with @reference support
 */
export function setupCodeMirrorEditor(container, getCurrentDoc, getCurrentProject) {
    const completionSource = createReferenceCompletion(getCurrentDoc, getCurrentProject);
    
    const state = EditorState.create({
        doc: "",
        extensions: [
            // Basic setup
            keymap.of([
                ...defaultKeymap,
                {
                    key: "Enter",
                    run: () => {
                        // Don't handle Enter - let the form handle it
                        return false;
                    }
                }
            ]),
            
            // Custom theme
            customTheme,
            
            // Reference highlighter
            referenceHighlighter,
            
            // Autocomplete for @references
            autocompletion({
                override: [completionSource],
                activateOnTyping: true,
                closeOnBlur: true,
                defaultKeymap: true
            }),
            
            // Line wrapping
            EditorView.lineWrapping
        ]
    });
    
    const view = new EditorView({
        state,
        parent: container
    });
    
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

