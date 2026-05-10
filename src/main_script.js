import { NetworkViz } from "./network_viz.js";
import OpenAIAgent, { GeminiAgent, LocalAgent, DEFAULT_LOCAL_BASE_URL, DEFAULT_LOCAL_MODEL } from "./ai_utils.js";
import { isRunningInVsCode } from "./host_bridge.js";
import Modal from "./modal.js";
import ChatManager from "./ai_chat.js";
import generateRandomName from "./random_name_generator.js";
import { setupCodeMirrorEditor } from "./codemirror_setup.js";
import { CARD_TYPE_CODE } from "./cards.js";
import { initCompileCtl } from "./controllers/compile_ctl.js";
import {
    initDocCtl,
    createDoc as ctlCreateDoc,
    addNewDoc as ctlAddNewDoc,
    removeCurrentDoc as ctlRemoveCurrentDoc,
    switchToDoc as ctlSwitchToDoc,
    setupDocTitleSanitization as ctlSetupDocTitleSanitization,
    setupDocDestinationInput as ctlSetupDocDestinationInput,
    showDocSummary as ctlShowDocSummary,
    startSummaryAnimation as ctlStartSummaryAnimation,
    summarySuccess as ctlSummarySuccess,
    summaryError as ctlSummaryError,
} from "./controllers/doc_ctl.js";
import {
    initProjectCtl,
    createProject as ctlCreateProject,
    setupProjectTitleSanitization as ctlSetupProjectTitleSanitization,
    exportProject as ctlExportProject,
    importProject as ctlImportProject,
    loadProjectFromJson as ctlLoadProjectFromJson,
    notifyProjectChanged as ctlNotifyProjectChanged,
    searchAndNavigate as ctlSearchAndNavigate,
} from "./controllers/project_ctl.js";
import {
    initCardCtl,
    rehydrateCurrentDoc as ctlRehydrateCurrentDoc,
    applyRehydrate as ctlApplyRehydrate,
    attachExistingCardListeners as ctlAttachExistingCardListeners,
} from "./controllers/card_ctl.js";
import { emit, on } from "./event_bus.js";

// Select all the dom elements
const network = document.getElementById("network");
const resetZoom = document.getElementById("resetZoom");
const project_title_input = document.getElementById("project_title_input");
// search stuff
const search_input = document.getElementById("search_input");
const search_btn = document.getElementById("search_btn");
// docs stuff
const doc_content = document.getElementById("doc-content");
const summary_btn = document.getElementById("summary_btn");
const add_doc = document.getElementById("add_doc");
const remove_doc = document.getElementById("remove_doc");
const doc_title_input = document.getElementById("doc_title_input");
const doc_destination_input = document.getElementById("doc_destination_input");
// editor actions
const undo_btn = document.getElementById("undo_btn");
const export_btn = document.getElementById("export_btn");
const import_btn = document.getElementById("import_btn");
const api_key_btn = document.getElementById("api_key_btn");
const feedback_btn = document.getElementById("feedback_btn");
const about_btn = document.getElementById("about_btn");
// chat stuff
const chat_content = document.getElementById("chat-content");
const prompt = document.getElementById("chat-prompt");
const send_prompt = document.getElementById("send_prompt");
const add_to_doc = document.getElementById("add_to_doc");
const card_title_input = document.getElementById("card_title_input");
const attach_image = document.getElementById("attach_image");
const image_preview_container = document.getElementById("image-preview-container");
const code_toggle = document.getElementById("code_toggle");
const compile_btn = document.getElementById("compile_btn");
const rehydrate_btn = document.getElementById("rehydrate_btn");
const exit_edit = document.getElementById("exit_edit");
const generate_all_btn = document.getElementById("generate_all_btn");

const buttons = {
    resetZoom: resetZoom,
    project_title_input: project_title_input,
    search_input: search_input,
    search_btn: search_btn,
    summary_btn: summary_btn,
    add_doc: add_doc,
    remove_doc: remove_doc,
    doc_title_input: doc_title_input,
    doc_destination_input: doc_destination_input,
    undo_btn: undo_btn,
    export_btn: export_btn,
    import_btn: import_btn,
    api_key_btn: api_key_btn,
    feedback_btn: feedback_btn,
    about_btn: about_btn,
    send_prompt: send_prompt,
    add_to_doc: add_to_doc,
    prompt: prompt,
    chat_content: chat_content,
    card_title_input: card_title_input,
    attach_image: attach_image,
    image_preview_container: image_preview_container,
    code_toggle: code_toggle,
    compile_btn: compile_btn,
    rehydrate_btn: rehydrate_btn,
    exit_edit: exit_edit,
    generate_all_btn: generate_all_btn
};

// main manager
class MainManager {
    constructor(network, log, chat, buttons) {
        this.network = network; // this is the network data structure
        this.log = log; // this is the log of events
        this.chat = chat; // this is the chat interface
        this.viz = null; // this will hold the network visualization instance
        this.buttons = buttons; // store button references
        this.ai_agent = null;
        this.modal = new Modal(); // custom modal for alerts and confirms
        this.promptEditor = null; // will hold the CodeMirror editor instance
        this.chatManager = null; // will hold the chat manager instance
        this.currentProject = null; // will hold the current project instance (root node)
        this.currentDoc = null; // will hold the current document instance
    }

    resetZoom() {
        this.viz.resetZoom();
        // Don't call zoomToFit - keeps graph naturally centered
    }

    /* ─── thin shims for controller delegation ─────────────────────────── */
    // Each method below is preserved on MainManager so external callers
    // (Card callbacks, ChatManager, host message listener) still work, but
    // the implementation lives in src/controllers/*.

    summary_btn() { return ctlShowDocSummary(); }
    startSummaryAnimation() { return ctlStartSummaryAnimation(); }
    summarySuccess() { return ctlSummarySuccess(); }
    summaryError(msg) { return ctlSummaryError(msg); }

    createNewProject(name) { return ctlCreateProject(name); }
    createNewDoc(title) { return ctlCreateDoc(title); }

    updateNetworkViz() {
        if (this.currentProject && this.viz) {
            const graphData = this.currentProject.toGraphData();
            this.viz.updateData(graphData);
        }
        // Every structural mutation funnels through here, so it's the
        // natural sync point for host notification.
        ctlNotifyProjectChanged();
    }

    addDocButton() { return ctlAddNewDoc(); }
    removeDocButton() { return ctlRemoveCurrentDoc(); }
    switchToDoc(doc) { return ctlSwitchToDoc(doc); }
    notifyProjectChanged() { return ctlNotifyProjectChanged(); }

    handleNodeClick(nodeData) {
        // Handle clicks on nodes in the network visualization
        console.log("Node clicked:", nodeData);
        
        // If it's the root project node (type: "project"), zoom to fit
        if (nodeData.type === "project") {
            console.log("Clicked on project root, zooming to fit...");
            this.resetZoom();
            return;
        }
        
        // If it's a doc node, switch to that document
        if (nodeData.type === "doc" && nodeData.id) {
            const doc = this.currentProject.getDoc(nodeData.id);
            if (doc) {
                console.log("Switching to doc:", doc.title);
                this.switchToDoc(doc);
            } else {
                console.error("Doc not found:", nodeData.id);
            }
            return;
        }
        
        // If it's a card node, switch to the document containing that card
        if (nodeData.type === "card" && nodeData.id) {
            console.log("Card node clicked:", nodeData.name);
            
            // Find which document contains this card
            const allDocs = this.currentProject.getAllDocs();
            for (const doc of allDocs) {
                const card = doc.getCard(nodeData.id);
                if (card) {
                    console.log("Found card in doc:", doc.title, "- switching to it");
                    this.switchToDoc(doc);
                    
                    // Scroll to the card after switching
                    setTimeout(() => {
                        const cardElements = Array.from(doc_content.querySelectorAll('.card'));
                        const cardElement = cardElements.find(el => {
                            const cardId = el.querySelector('.card_details p').textContent;
                            return cardId === nodeData.id;
                        });
                        
                        if (cardElement) {
                            cardElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            cardElement.classList.add('card--flash');
                            setTimeout(() => cardElement.classList.remove('card--flash'), 500);
                        }
                    }, 100);
                    
                    return;
                }
            }
            
            console.warn("Card not found in any document:", nodeData.id);
        }
    }

    setupProjectTitleSanitization() { return ctlSetupProjectTitleSanitization(); }
    setupDocDestinationInput() { return ctlSetupDocDestinationInput(); }
    setupDocTitleSanitization() { return ctlSetupDocTitleSanitization(); }

    toggleCodeMode() {
        if (!this.chatManager) return;
        this.chatManager.codeMode = !this.chatManager.codeMode;
        const btn = this.buttons.code_toggle;
        if (btn) {
            btn.setAttribute('aria-pressed', String(this.chatManager.codeMode));
            btn.classList.toggle('toggle-active', this.chatManager.codeMode);
        }
        if (this.promptEditor && typeof this.promptEditor.setLanguage === 'function') {
            this.promptEditor.setLanguage(this.chatManager.codeMode ? 'python' : 'markdown');
        }
    }

    setupHostMessageListener() {
        if (typeof window === 'undefined') return;
        // Bridge for VS Code commands and the custom-editor sync protocol.
        // Browser hosts never receive any of these.
        this._hostMessageHandler = (event) => {
            const msg = event && event.data;
            if (!msg || typeof msg.type !== 'string') return;
            switch (msg.type) {
                case 'compile-current':
                    this.compileCurrentDoc();
                    break;
                case 'toggle-code':
                    this.toggleCodeMode();
                    break;
                case 'rehydrate-result':
                    this.applyRehydrate(msg);
                    break;
                case 'load-state':
                    if (typeof msg.state === 'string' && msg.state.length > 0) {
                        // Suppress echoes of our own commits. The custom editor
                        // re-broadcasts `load-state` after every save, which would
                        // otherwise tear down the chat editor (clearAll) and rebuild
                        // every Card DOM mid-walkthrough.
                        if (this._lastSentState && msg.state === this._lastSentState) {
                            break;
                        }
                        // Defensive: while a Generate-All walkthrough is in flight,
                        // never let a host-driven rehydrate clobber editor state.
                        if (this.walkthroughActive) {
                            this._pendingLoadState = msg.state;
                            break;
                        }
                        try {
                            const data = JSON.parse(msg.state);
                            this.loadProjectFromJson(data);
                        } catch (err) {
                            console.warn('load-state: invalid project JSON:', err);
                        }
                    }
                    break;
            }
        };
        window.addEventListener('message', this._hostMessageHandler);

        // If the host baked an initial project into the page (custom editor case),
        // hydrate from it now. Done after listener wiring so any subsequent
        // load-state arrives at a consistent moment.
        if (typeof window.__slateInitialProject === 'string' && window.__slateInitialProject.length > 0) {
            try {
                const data = JSON.parse(window.__slateInitialProject);
                this.loadProjectFromJson(data);
            } catch (err) {
                console.warn('Failed to hydrate from __slateInitialProject:', err);
            }
        }
    }

    rehydrateCurrentDoc() { return ctlRehydrateCurrentDoc(); }
    applyRehydrate(payload) { return ctlApplyRehydrate(payload); }

    /**
     * Human-in-the-loop GENERATE ALL. Walks the current doc top-to-bottom and
     * for each unresolved card (no content, has prompt, not a header) it:
     *
     *   1. Loads the card into the editor (prompt + title populated).
     *   2. Auto-fires SEND so the response streams into the response pane.
     *   3. Waits — the user reviews/edits, then clicks ADD TO DOC to approve
     *      (= "yes, freeze this") or EXIT EDIT to abort the whole walk.
     *   4. On approval, advances to the next unresolved card.
     *
     * The advance happens via `advanceWalkthrough()`, called from
     * ChatManager.addToDoc on a successful commit.
     */
    async startGenerateWalkthrough() {
        if (!this.currentDoc) {
            await this.modal.alert("No document selected.");
            return;
        }
        const initial = this._collectUnresolvedCards();
        if (initial.length === 0) {
            await this.modal.alert("Nothing to generate — every card with a prompt already has content.");
            return;
        }

        const agent = this.chatManager.resolveAgentFor(true);
        if (!agent || (typeof agent.hasApiKey === 'function' && !agent.hasApiKey())) {
            await this.modal.alert("Local model not configured. Click API KEY to set provider/model.");
            return;
        }

        this.walkthroughActive = true;
        // We DO NOT cache the card list — the VS Code custom editor auto-saves
        // every commit, which can echo a `load-state` back and rebuild
        // currentDoc with fresh Card objects. Any cached queue would then
        // hold stale refs that don't match anything in the live doc. Instead
        // we re-scan the current doc each iteration and pick the next
        // eligible card by identity in the live doc.
        this.walkthroughTotal = initial.length;
        this.walkthroughDocId = this.currentDoc.id;
        document.body.classList.add('slate-walkthrough-active');
        console.log(`[walkthrough] start — ${initial.length} card(s) eligible`);
        this.loadNextWalkthroughCard();
    }

    /**
     * Re-scan the CURRENT doc (not a cached snapshot) for cards eligible for
     * walkthrough generation: not header, has non-empty prompt, has empty
     * content. Fresh on every call → survives load-state rebuilds.
     */
    _collectUnresolvedCards() {
        if (!this.currentDoc) return [];
        return this.currentDoc.getAllCards().filter(c =>
            c.kind !== 'header'
            && (c.prompt && c.prompt.trim().length > 0)
            && (!c.content || !c.content.trim().length)
        );
    }

    /**
     * Re-scan and pick the next eligible card, hydrate the editor, fire SEND.
     * Closes out the walkthrough if no eligible cards remain or if the user
     * navigated away from the doc we started in.
     */
    loadNextWalkthroughCard() {
        if (!this.walkthroughActive) return;

        // Bail if the user navigated to a different doc mid-walkthrough.
        if (!this.currentDoc || this.currentDoc.id !== this.walkthroughDocId) {
            console.warn('[walkthrough] doc changed mid-walkthrough — aborting');
            this.endWalkthrough({ aborted: true });
            return;
        }

        const remaining = this._collectUnresolvedCards();
        if (remaining.length === 0) {
            this.endWalkthrough({ completed: true });
            return;
        }
        const card = remaining[0];
        const completed = this.walkthroughTotal - remaining.length;
        const positionLabel = `${completed + 1}/${this.walkthroughTotal}`;
        console.log(`[walkthrough] loading ${positionLabel}: "${card.title}" (${remaining.length} remaining); prompt.len=${(card.prompt || '').length}`);

        // Force cardType=code before loadCardForEdit so its isCode check
        // matches the codeMode we're about to set, instead of toggling
        // codeMode OFF on us (and silently switching to markdown system
        // prompt). All synchronous — no dynamic import — to avoid any
        // microtask race where state-changed echoes could shuffle things
        // between hydration and SEND.
        try {
            card.cardType = CARD_TYPE_CODE;
            if (!this.chatManager.codeMode) this.toggleCodeMode();
            this.chatManager.loadCardForEdit(card);
        } catch (err) {
            console.error('[walkthrough] loadCardForEdit threw:', err);
            this.endWalkthrough({ aborted: true });
            return;
        }

        // Sanity check: after loadCardForEdit the prompt editor MUST contain
        // card.prompt — otherwise askAI will pop the "Type a prompt before
        // clicking SEND" alert and the walkthrough will appear to hang.
        const editorText = this.chatManager.promptEditor
            ? this.chatManager.promptEditor.state.doc.toString()
            : '';
        if (!editorText.trim()) {
            console.error(`[walkthrough] prompt editor is empty after loadCardForEdit for "${card.title}" (card.prompt.len=${(card.prompt || '').length}). Aborting walkthrough to avoid hang.`);
            this.endWalkthrough({ aborted: true });
            return;
        }

        const status = document.getElementById('status-bar-project');
        if (status) status.textContent = `Walkthrough ${positionLabel}: ${card.title} — review & approve.`;

        this.chatManager.askAI();
    }

    /**
     * Called from ChatManager.addToDoc on a successful commit. Returns true if
     * we consumed the event (advanced to next or completed), false otherwise.
     */
    advanceWalkthrough() {
        if (!this.walkthroughActive) return false;
        // Tiny defer so the previous card's commit settles before we re-mount
        // the editor for the next card.
        setTimeout(() => this.loadNextWalkthroughCard(), 0);
        return true;
    }

    /**
     * Tear down walkthrough state. Called on completion, on abort via
     * cancelEdit/EXIT EDIT, and defensively on doc switch.
     */
    endWalkthrough({ completed = false, aborted = false } = {}) {
        const wasActive = this.walkthroughActive;
        const total = this.walkthroughTotal || 0;
        this.walkthroughActive = false;
        this.walkthroughDocId = null;
        document.body.classList.remove('slate-walkthrough-active');
        const status = document.getElementById('status-bar-project');
        if (status) {
            if (completed) status.textContent = `Walkthrough complete (${total} cards).`;
            else if (aborted) status.textContent = `Walkthrough aborted.`;
        }
        console.log(`[walkthrough] end — completed=${completed}, aborted=${aborted}, total=${total}`);
        // Drain any deferred host rehydrate. If it's just an echo of what we
        // last sent, drop it; otherwise reapply so we stay in sync with disk.
        if (this._pendingLoadState) {
            const pending = this._pendingLoadState;
            this._pendingLoadState = null;
            if (!this._lastSentState || pending !== this._lastSentState) {
                try {
                    this.loadProjectFromJson(JSON.parse(pending));
                } catch (err) {
                    console.warn('endWalkthrough: deferred load-state invalid:', err);
                }
            }
        }
        if (wasActive && completed) {
            // Don't await — alert just notifies; user already saw cards land.
            this.modal.alert(`Walkthrough complete — generated ${total} cards.`);
        }
    }

    /**
     * Fires the `compile:requested` event; compile_ctl handles the rest and
     * emits `compile:succeeded` / `compile:failed`, which we subscribe to in
     * setupCompileEventListeners() to surface a modal.
     */
    compileCurrentDoc() {
        if (!this.currentDoc) {
            this.modal.alert("No document to compile.");
            return;
        }
        emit('compile:requested', {
            doc: this.currentDoc,
            project: this.currentProject,
        });
    }

    /**
     * Subscribe once to compile_ctl's outcome events. The controller is the
     * source of truth for whether the compile worked; we just translate the
     * payload into a human-readable modal here.
     */
    setupCompileEventListeners() {
        if (this._compileListenersWired) return;
        this._compileListenersWired = true;

        on('compile:succeeded', ({ filename, destination, warnings, delivery }) => {
            const relPath = destination ? `${destination}/${filename}` : filename;
            const where = delivery === 'vscode'
                ? `Wrote ${relPath} to the VS Code workspace.`
                : `Downloaded ${filename}.`;
            const warningTxt = warnings && warnings.length
                ? `\n\nWarnings:\n${warnings.join('\n')}`
                : '';
            this.modal.alert(`Compiled successfully. ${where}${warningTxt}`);
        });

        on('compile:failed', ({ error }) => {
            this.modal.alert(`Compile failed:\n${error}`);
        });
    }

    getAgentForProvider(provider, openaiKey, geminiKey) {
        if (provider === 'gemini') {
            const agent = new GeminiAgent();
            if (geminiKey) agent.updateApiKey(geminiKey);
            return agent;
        }
        if (provider === 'local') {
            const baseURL = localStorage.getItem('local_base_url') || DEFAULT_LOCAL_BASE_URL;
            const modelName = localStorage.getItem('local_model_name') || DEFAULT_LOCAL_MODEL;
            return new LocalAgent(baseURL, modelName);
        }
        const agent = new OpenAIAgent();
        if (openaiKey) agent.updateApiKey(openaiKey);
        return agent;
    }

    async show_api_key_modal() {
        const currentOpenAI = localStorage.getItem('openai_api_key') || '';
        const currentGemini = localStorage.getItem('gemini_api_key') || '';
        const currentProvider = localStorage.getItem('ai_provider') || 'openai';
        const currentLocalBaseURL = localStorage.getItem('local_base_url') || DEFAULT_LOCAL_BASE_URL;
        const currentLocalModel = localStorage.getItem('local_model_name') || DEFAULT_LOCAL_MODEL;
        const inputContainer = document.createElement('div');
        inputContainer.innerHTML = `
            <h4 style="margin-bottom: 12px;">AI provider & API keys</h4>
            <label style="display: block; margin-bottom: 4px; font-size: small;">Use model</label>
            <select id="ai_provider_select" style="width: 100%; padding: 8px; margin-bottom: 12px; background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2);">
                <option value="openai" ${currentProvider === 'openai' ? 'selected' : ''}>OpenAI (GPT)</option>
                <option value="gemini" ${currentProvider === 'gemini' ? 'selected' : ''}>Gemini</option>
                <option value="local" ${currentProvider === 'local' ? 'selected' : ''}>Local (Ollama)</option>
            </select>
            <label style="display: block; margin-bottom: 4px; font-size: small;">OpenAI API key</label>
            <input type="password" id="openai_api_key_input" placeholder="sk-..."
                   style="width: 100%; padding: 8px; font-family: 'Courier New', monospace; font-size: small; background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2); margin-bottom: 12px;"
                   value="${currentOpenAI}">
            <label style="display: block; margin-bottom: 4px; font-size: small;">Gemini API key</label>
            <input type="password" id="gemini_api_key_input" placeholder="Gemini key (Google AI Studio)..."
                   style="width: 100%; padding: 8px; font-family: 'Courier New', monospace; font-size: small; background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2); margin-bottom: 12px;"
                   value="${currentGemini}">
            <label style="display: block; margin-bottom: 4px; font-size: small;">Local base URL</label>
            <input type="text" id="local_base_url_input" placeholder="http://localhost:11434/v1"
                   style="width: 100%; padding: 8px; font-family: 'Courier New', monospace; font-size: small; background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2); margin-bottom: 12px;"
                   value="${currentLocalBaseURL}">
            <label style="display: block; margin-bottom: 4px; font-size: small;">Local model name</label>
            <input type="text" id="local_model_name_input" placeholder="qwen3-coder:30b"
                   style="width: 100%; padding: 8px; font-family: 'Courier New', monospace; font-size: small; background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2);"
                   value="${currentLocalModel}">
            <p style="margin-top: 10px; font-size: x-small;">Keys are stored locally in your browser. For local models via Ollama, run <code>OLLAMA_ORIGINS='*' ollama serve</code> so the browser can reach it.</p>
        `;

        const result = await this.modal.custom(inputContainer, [
            {
                text: 'Cancel',
                className: 'alert_btn',
                callback: () => null
            },
            {
                text: 'Clear all',
                className: 'alert_btn',
                callback: () => {
                    localStorage.removeItem('openai_api_key');
                    localStorage.removeItem('gemini_api_key');
                    localStorage.removeItem('local_base_url');
                    localStorage.removeItem('local_model_name');
                    localStorage.setItem('ai_provider', 'openai');
                    this.ai_agent = new OpenAIAgent();
                    if (this.chatManager && this.chatManager.aiAgent) {
                        this.chatManager.aiAgent = this.ai_agent;
                    }
                    return 'cleared';
                }
            },
            {
                text: 'Save',
                className: 'success_btn',
                callback: () => {
                    const provider = document.getElementById('ai_provider_select').value;
                    const openaiKey = document.getElementById('openai_api_key_input').value.trim();
                    const geminiKey = document.getElementById('gemini_api_key_input').value.trim();
                    const localBaseURL = document.getElementById('local_base_url_input').value.trim();
                    const localModel = document.getElementById('local_model_name_input').value.trim();
                    localStorage.setItem('ai_provider', provider);
                    if (openaiKey) localStorage.setItem('openai_api_key', openaiKey);
                    else localStorage.removeItem('openai_api_key');
                    if (geminiKey) localStorage.setItem('gemini_api_key', geminiKey);
                    else localStorage.removeItem('gemini_api_key');
                    if (localBaseURL) localStorage.setItem('local_base_url', localBaseURL);
                    else localStorage.removeItem('local_base_url');
                    if (localModel) localStorage.setItem('local_model_name', localModel);
                    else localStorage.removeItem('local_model_name');
                    this.ai_agent = this.getAgentForProvider(provider, openaiKey, geminiKey);
                    if (this.chatManager && this.chatManager.aiAgent) {
                        this.chatManager.aiAgent = this.ai_agent;
                    }
                    return 'saved';
                }
            }
        ]);

        if (result === 'saved') {
            await this.modal.alert("Settings saved. You can use AI with the selected model.");
        } else if (result === 'cleared') {
            await this.modal.alert("API keys cleared. Set a key and choose a model to use AI.");
        }
    }

    async showAboutModal() {
        // Show about modal with creator info and link
        const aboutContent = document.createElement('div');
        aboutContent.innerHTML = `
            <p style="margin-bottom: 15px;">
                Check out more of my work at 
                <a href="https://www.indrajeethaldar.com" target="_blank" 
                   style="color: var(--information-1); text-decoration: underline;">
                    www.indrajeethaldar.com
                </a>
            </p>
            <p style="margin-bottom: 0; font-size: x-small; line-height: 1.6; border-top: 1px solid var(--information-2); padding-top: 15px;">
                <a href="https://www.slate-notepad.com/">slate notebook editor</a> © 2025 by <a href="https://www.indrajeethaldar.com/">Indrajeet Haldar</a> is licensed under <a href="https://creativecommons.org/licenses/by-nc-nd/4.0/">CC BY-NC-ND 4.0</a><img src="https://mirrors.creativecommons.org/presskit/icons/cc.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/by.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/nc.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/nd.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;">
            </p>
        `;

        await this.modal.custom(aboutContent, [
            {
                text: 'OK',
                className: 'info_btn',
                callback: () => null
            }
        ]);
    }

    exportProject() { return ctlExportProject(); }
    importProject() { return ctlImportProject(); }
    loadProjectFromJson(jsonData) { return ctlLoadProjectFromJson(jsonData); }
    searchAndNavigate() { return ctlSearchAndNavigate(); }


    mapButtons() {
        // Hide browser-only chrome when slate is hosted inside VS Code. The
        // *.slate.json file IS the project on the VS Code surface — IMPORT,
        // EXPORT, ABOUT, and FEEDBACK only make sense for the standalone
        // web/GitHub-Pages surface where there's no host filesystem.
        if (isRunningInVsCode()) {
            for (const id of ['import_btn', 'export_btn', 'about_btn', 'feedback_btn']) {
                const el = this.buttons[id];
                if (el) el.style.display = 'none';
            }
        }

        this.buttons.resetZoom.addEventListener("click", () => this.resetZoom());
        this.buttons.summary_btn.addEventListener("click", () => this.summary_btn());
        this.buttons.add_doc.addEventListener("click", () => this.addDocButton());
        this.buttons.remove_doc.addEventListener("click", () => this.removeDocButton());
        this.buttons.add_to_doc.addEventListener("click", () => this.chatManager.addToDoc());
        this.buttons.send_prompt.addEventListener("click", () => this.chatManager.askAI());
        if (this.buttons.code_toggle) {
            this.buttons.code_toggle.addEventListener("click", () => this.toggleCodeMode());
        }
        if (this.buttons.compile_btn) {
            this.buttons.compile_btn.addEventListener("click", () => this.compileCurrentDoc());
        }
        if (this.buttons.rehydrate_btn) {
            this.buttons.rehydrate_btn.addEventListener("click", () => this.rehydrateCurrentDoc());
        }
        if (this.buttons.generate_all_btn) {
            this.buttons.generate_all_btn.addEventListener("click", () => this.startGenerateWalkthrough());
        }
        if (this.buttons.exit_edit) {
            this.buttons.exit_edit.addEventListener("click", () => this.chatManager.cancelEdit());
        }
        // ESC anywhere also exits edit mode (unless focus is in a CodeMirror
        // editor where ESC has its own meaning — we still hijack it because
        // there's no other ESC binding worth preserving in slate today).
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.body.classList.contains('slate-editing-card')) {
                this.chatManager.cancelEdit();
            }
        });
        this.buttons.api_key_btn.addEventListener("click", () => this.show_api_key_modal());
        this.buttons.about_btn.addEventListener("click", () => this.showAboutModal());
        this.buttons.feedback_btn.addEventListener("click", () => {
            window.open("https://forms.gle/BVk3YMzqoRELDy2C9", "_blank");
        });
        this.buttons.export_btn.addEventListener("click", () => this.exportProject());
        this.buttons.import_btn.addEventListener("click", () => this.importProject());
        this.buttons.search_btn.addEventListener("click", () => this.searchAndNavigate());
        
        // Also allow Enter key in search input
        this.buttons.search_input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                this.searchAndNavigate();
            }
        });
    }

    attachExistingCardListeners() { return ctlAttachExistingCardListeners(); }

    setupContentResizers() {
        const content = document.getElementById("content");
        const chat = document.getElementById("chat");
        const doc = document.getElementById("doc");
        const network = document.getElementById("network");
        const resizerChatDoc = document.getElementById("resizer-chat-doc");
        const resizerDocNetwork = document.getElementById("resizer-doc-network");
        const MIN_PANEL = 180;

        function startResize(resizer, leftPanel, rightPanel) {
            let startX = 0;
            let startLeft = 0;
            let startRight = 0;

            function onMove(e) {
                const dx = e.clientX - startX;
                const contentRect = content.getBoundingClientRect();
                const total = contentRect.width;
                const resizerW = 8;
                const minLeft = MIN_PANEL;
                const minRight = MIN_PANEL;
                let newLeft = startLeft + dx;
                let newRight = startRight - dx;
                if (newLeft < minLeft) {
                    newLeft = minLeft;
                    newRight = startLeft + startRight - minLeft;
                } else if (newRight < minRight) {
                    newRight = minRight;
                    newLeft = startLeft + startRight - minRight;
                }
                leftPanel.style.flex = `0 0 ${newLeft}px`;
                rightPanel.style.flex = `0 0 ${newRight}px`;
                startX = e.clientX;
                startLeft = newLeft;
                startRight = newRight;
            }

            function onUp() {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            }

            resizer.addEventListener("mousedown", (e) => {
                e.preventDefault();
                startX = e.clientX;
                startLeft = leftPanel.getBoundingClientRect().width;
                startRight = rightPanel.getBoundingClientRect().width;
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
            });
        }

        startResize(resizerChatDoc, chat, doc);
        startResize(resizerDocNetwork, doc, network);
    }

    setupNetworkResizeObserver() {
        const container = this.network;
        if (!container || !this.viz) return;
        const ro = new ResizeObserver(() => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w > 0 && h > 0) this.viz.resize(w, h);
        });
        ro.observe(container);
    }

    setupMobileTabs() {
        const tabs = document.getElementById("bottom-tabs");
        if (!tabs) return;
        const panels = { chat: document.getElementById("chat"), doc: document.getElementById("doc"), network: document.getElementById("network") };
        const tabButtons = tabs.querySelectorAll(".mobile-tab");

        function showPanel(panelId) {
            tabButtons.forEach((btn) => {
                const id = btn.getAttribute("data-panel");
                const isActive = id === panelId;
                btn.classList.toggle("active", isActive);
                btn.setAttribute("aria-pressed", isActive ? "true" : "false");
                if (panels[id]) {
                    panels[id].classList.toggle("mobile-active", isActive);
                }
            });
        }

        tabButtons.forEach((btn) => {
            btn.addEventListener("click", () => showPanel(btn.getAttribute("data-panel")));
        });

        if (window.matchMedia("(max-width: 768px)").matches) {
            showPanel("chat");
        }
    }

    async init() {
        // Wire up controller contexts BEFORE any controller-backed method runs.
        // Order matters: project_ctl is consulted by updateNetworkViz (via
        // ctlNotifyProjectChanged), and doc_ctl.createDoc calls updateViz on
        // first project creation. card_ctl is wired here for symmetry.
        initProjectCtl({
            getProject: () => this.currentProject,
            setProject: (p) => { this.currentProject = p; },
            getCurrentDoc: () => this.currentDoc,
            setCurrentDoc: (d) => { this.currentDoc = d; },
            getModal: () => this.modal,
            getButtons: () => this.buttons,
            getDocContent: () => doc_content,
            updateViz: () => this.updateNetworkViz(),
            syncChat: () => { if (this.chatManager) this.chatManager.currentDoc = this.currentDoc; },
            clearChat: () => { if (this.chatManager) this.chatManager.clearChat(); },
            resetChat: () => { if (this.chatManager) this.chatManager.clearAll(); },
            switchToDoc: (doc) => this.switchToDoc(doc),
            setHydrating: (v) => { this._hydrating = v; },
            isHydrating: () => !!this._hydrating,
            recordLastSentState: (json) => { this._lastSentState = json; },
        });
        initDocCtl({
            getProject: () => this.currentProject,
            getCurrentDoc: () => this.currentDoc,
            setCurrentDoc: (doc) => { this.currentDoc = doc; },
            getModal: () => this.modal,
            getDocContent: () => doc_content,
            getButtons: () => this.buttons,
            updateViz: () => this.updateNetworkViz(),
            syncChat: () => { if (this.chatManager) this.chatManager.currentDoc = this.currentDoc; },
            clearChat: () => { if (this.chatManager) this.chatManager.clearChat(); },
            notifyChange: () => this.notifyProjectChanged(),
        });
        initCardCtl({
            getProject: () => this.currentProject,
            getCurrentDoc: () => this.currentDoc,
            getModal: () => this.modal,
            getDocContent: () => doc_content,
            switchToDoc: (doc) => this.switchToDoc(doc),
            updateViz: () => this.updateNetworkViz(),
        });

        // Create a new project (root node)
        const projectName = generateRandomName();
        this.createNewProject(projectName);
        this.buttons.project_title_input.value = projectName;
        
        // Initialize the network visualization with empty data first and click callback
        this.viz = new NetworkViz(
            "#network", 
            { nodes: [], links: [] }, 
            this.network.clientWidth, 
            this.network.clientHeight,
            (nodeData) => this.handleNodeClick(nodeData)
        );
        
        // Initialize the AI agent (OpenAI or Gemini based on saved preference)
        const provider = localStorage.getItem('ai_provider') || 'openai';
        const openaiKey = localStorage.getItem('openai_api_key') || "";
        const geminiKey = localStorage.getItem('gemini_api_key') || "";
        this.ai_agent = this.getAgentForProvider(provider, openaiKey, geminiKey);
        
        // Generate and set random doc name
        const docName = generateRandomName();
        this.buttons.doc_title_input.value = docName;
        
        // Create a new blank document (will be added to project and update viz)
        this.createNewDoc(docName);
        
        // Initialize CodeMirror editor for the prompt. Defaults to markdown
        // syntax highlighting (headings, lists, code fences, links — all
        // monad-themed); flips to python when code mode toggles on.
        this.promptEditor = setupCodeMirrorEditor(
            this.buttons.prompt,
            () => this.currentDoc,
            () => this.currentProject,
            { language: 'markdown' }
        );
        
        // Initialize the chat manager
        this.chatManager = new ChatManager(
            this.buttons.chat_content,
            this.promptEditor,
            this.buttons.card_title_input,
            doc_content,
            this.ai_agent,
            this.modal,
            this.currentDoc,
            () => this.updateNetworkViz() // callback to update network viz
        );
        
        // Setup image support for the chat manager
        this.chatManager.setupImageSupport(
            this.buttons.attach_image,
            this.buttons.image_preview_container
        );
        
        // listen for inbound messages from a VS Code extension host (no-op in browser)
        this.setupHostMessageListener();
        // wire the compile controller (Phase B per ARCHITECTURE.md)
        initCompileCtl();
        this.setupCompileEventListeners();
        // map all the buttons
        this.mapButtons();
        // attach listeners to existing static cards
        this.attachExistingCardListeners();
        // setup project title sanitization
        this.setupProjectTitleSanitization();
        // setup doc title sanitization
        this.setupDocTitleSanitization();
        // setup doc destination input
        this.setupDocDestinationInput();
        // set default chat message
        this.chatManager.setDefaultMessage();
        // resizable content panels
        this.setupContentResizers();
        this.setupNetworkResizeObserver();
        this.setupMobileTabs();

        let resizeTimer = null;
        this._resizeHandler = () => {
            if (resizeTimer !== null) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                resizeTimer = null;
                if (window.matchMedia("(max-width: 768px)").matches) {
                    const active = document.querySelector("#content .panel.mobile-active");
                    if (!active) {
                        document.getElementById("chat").classList.add("mobile-active");
                        document.querySelector('.mobile-tab[data-panel="chat"]').classList.add("active");
                        document.querySelector('.mobile-tab[data-panel="chat"]').setAttribute("aria-pressed", "true");
                    }
                }
            }, 100);
        };
        window.addEventListener("resize", this._resizeHandler);
    }

    /**
     * Detach global listeners and tear down children. Safe to call multiple times.
     */
    destroy() {
        if (this._resizeHandler) {
            window.removeEventListener("resize", this._resizeHandler);
            this._resizeHandler = null;
        }
        if (this.chatManager && typeof this.chatManager.destroy === "function") {
            this.chatManager.destroy();
        }
        if (this._hostMessageHandler) {
            window.removeEventListener('message', this._hostMessageHandler);
            this._hostMessageHandler = null;
        }
    }
}

// Initialize the main manager
const mainManager = new MainManager(network, doc_content, chat_content, buttons);
await mainManager.init();

// Expose mainManager globally for cross-component access (e.g., ChatManager accessing project)
window.mainManager = mainManager;
