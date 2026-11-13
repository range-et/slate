/**
 * Slate Interactive Micro-Canvas & Educational Explainer
 * Powers the interactive walkthrough on the Monad landing page.
 */

export interface NodeDefinition {
  id: string;
  name: string;
  kind: 'input' | 'atomic';
  signature: string;
  lines: number;
  jpl60: boolean;
  docstring: string;
  code: string;
  tests: string;
  packet: {
    target: string;
    signature: string;
    intent: string;
    contract: string;
    cases: Array<{ inputs: Record<string, number | string>; expected: number | string }>;
    tokens: number;
    budgetLimit: number;
  };
}

export const EXPLAINER_NODES: Record<string, NodeDefinition> = {
  clamp: {
    id: 'clamp',
    name: 'clamp',
    kind: 'atomic',
    signature: 'def clamp(val: float, low: float = 0.0, high: float = 10.0) -> float',
    lines: 7,
    jpl60: true,
    docstring: 'Clamp val strictly between [low, high]. NASA JPL-60 compliant.',
    code: `from pydantic import validate_call

@validate_call(validate_return=True)
def clamp(val: float, low: float = 0.0, high: float = 10.0) -> float:
    """Clamp val strictly between [low, high]. NASA JPL-60 compliant."""
    if low > high:
        raise ValueError("low must be <= high")
    return max(low, min(val, high))`,
    tests: `def test_clamp_within_bounds():
    assert clamp(5.0, 0.0, 10.0) == 5.0

def test_clamp_upper_limit():
    assert clamp(15.0, 0.0, 10.0) == 10.0

def test_clamp_lower_limit():
    assert clamp(-3.0, 0.0, 10.0) == 0.0`,
    packet: {
      target: 'clamp',
      signature: 'def clamp(val: float, low: float = 0.0, high: float = 10.0) -> float',
      intent: 'Clamp val strictly between [low, high]. NASA JPL-60 compliant.',
      contract: '@validate_call; raises ValueError if low > high',
      cases: [
        { inputs: { val: 5.0, low: 0.0, high: 10.0 }, expected: 5.0 },
        { inputs: { val: 15.0, low: 0.0, high: 10.0 }, expected: 10.0 },
        { inputs: { val: -3.0, low: 0.0, high: 10.0 }, expected: 0.0 }
      ],
      tokens: 342,
      budgetLimit: 600
    }
  },
  normalize: {
    id: 'normalize',
    name: 'normalize',
    kind: 'atomic',
    signature: 'def normalize(score: float, max_score: float = 10.0) -> float',
    lines: 6,
    jpl60: true,
    docstring: 'Scale clamped score to normalized unit ratio in range [0.0, 1.0].',
    code: `from pydantic import validate_call

@validate_call(validate_return=True)
def normalize(score: float, max_score: float = 10.0) -> float:
    """Scale clamped score to normalized unit ratio in range [0.0, 1.0]."""
    if max_score <= 0.0:
        raise ValueError("max_score must be positive")
    return round(score / max_score, 4)`,
    tests: `def test_normalize_ceiling():
    assert normalize(10.0, 10.0) == 1.0

def test_normalize_midpoint():
    assert normalize(5.0, 10.0) == 0.5`,
    packet: {
      target: 'normalize',
      signature: 'def normalize(score: float, max_score: float = 10.0) -> float',
      intent: 'Scale clamped score to normalized unit ratio in range [0.0, 1.0].',
      contract: '@validate_call; raises ValueError if max_score <= 0',
      cases: [
        { inputs: { score: 10.0, max_score: 10.0 }, expected: 1.0 },
        { inputs: { score: 5.0, max_score: 10.0 }, expected: 0.5 }
      ],
      tokens: 312,
      budgetLimit: 600
    }
  },
  evaluate_tier: {
    id: 'evaluate_tier',
    name: 'evaluate_tier',
    kind: 'atomic',
    signature: 'def evaluate_tier(ratio: float) -> str',
    lines: 8,
    jpl60: true,
    docstring: 'Classify normalized score ratio into performance tier.',
    code: `from pydantic import validate_call

@validate_call(validate_return=True)
def evaluate_tier(ratio: float) -> str:
    """Classify normalized score ratio into performance tier."""
    if ratio >= 0.85:
        return "TIER_A (Excellent)"
    if ratio >= 0.60:
        return "TIER_B (Proficient)"
    return "TIER_C (Needs Review)"`,
    tests: `def test_tier_a():
    assert evaluate_tier(0.95) == "TIER_A (Excellent)"

def test_tier_b():
    assert evaluate_tier(0.72) == "TIER_B (Proficient)"

def test_tier_c():
    assert evaluate_tier(0.40) == "TIER_C (Needs Review)"`,
    packet: {
      target: 'evaluate_tier',
      signature: 'def evaluate_tier(ratio: float) -> str',
      intent: 'Classify normalized score ratio into performance tier.',
      contract: '@validate_call; expects ratio in [0.0, 1.0]',
      cases: [
        { inputs: { ratio: 0.95 }, expected: 'TIER_A (Excellent)' },
        { inputs: { ratio: 0.72 }, expected: 'TIER_B (Proficient)' },
        { inputs: { ratio: 0.40 }, expected: 'TIER_C (Needs Review)' }
      ],
      tokens: 295,
      budgetLimit: 600
    }
  }
};

export interface PipelineState {
  rawScore: number;
  clampedScore: number;
  normalizedRatio: number;
  tier: string;
}

export function computePipeline(rawScore: number): PipelineState {
  const clampedScore = Math.max(0.0, Math.min(rawScore, 10.0));
  const normalizedRatio = Number((clampedScore / 10.0).toFixed(4));
  let tier = 'TIER_C (Needs Review)';
  if (normalizedRatio >= 0.85) {
    tier = 'TIER_A (Excellent)';
  } else if (normalizedRatio >= 0.60) {
    tier = 'TIER_B (Proficient)';
  }
  return { rawScore, clampedScore, normalizedRatio, tier };
}

export function generateCompiledPython(rawScore: number): string {
  const result = computePipeline(rawScore);
  return `# Compiled from flows/main.json by compilePython
# Deterministic graph execution: 0 hallucinated glue code

from nodes.clamp import clamp
from nodes.normalize import normalize
from nodes.evaluate_tier import evaluate_tier

def score_pipeline(raw_score: float) -> str:
    """Wired dataflow graph compiled deterministically without LLMs."""
    val_clamped = clamp(val=raw_score, low=0.0, high=10.0)
    ratio = normalize(score=val_clamped, max_score=10.0)
    tier = evaluate_tier(ratio=ratio)
    return tier

# Live evaluation on canvas:
# score_pipeline(${rawScore}) -> "${result.tier}"
`;
}

/**
 * Mount the interactive micro-canvas and inspector in the DOM.
 */
export function initExplainerStudio(): void {
  const slider = document.getElementById('explainer-slider') as HTMLInputElement | null;
  const numInput = document.getElementById('explainer-num') as HTMLInputElement | null;
  const valDisplay = document.getElementById('port-val-input');
  const clampDisplay = document.getElementById('port-val-clamped');
  const normDisplay = document.getElementById('port-val-norm');
  const tierDisplay = document.getElementById('port-val-tier');

  const inspectorTitle = document.getElementById('inspector-title');
  const inspectorSig = document.getElementById('inspector-sig');
  const inspectorLines = document.getElementById('inspector-lines');
  const inspectorCode = document.getElementById('inspector-code');
  const inspectorTests = document.getElementById('inspector-tests');
  const inspectorPacket = document.getElementById('inspector-packet');
  const inspectorTokens = document.getElementById('inspector-tokens');
  const inspectorCompiled = document.getElementById('inspector-compiled');

  const tabButtons = document.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]');
  const tabPanes = document.querySelectorAll<HTMLElement>('[data-tab-pane]');
  const nodeCards = document.querySelectorAll<HTMLElement>('[data-node-id]');
  const stepButtons = document.querySelectorAll<HTMLButtonElement>('[data-walkthrough-step]');
  const stepCallout = document.getElementById('walkthrough-callout');
  const simForgeBtn = document.getElementById('sim-forge-btn');
  const forgeStatus = document.getElementById('forge-sim-status');

  let activeNodeId = 'clamp';
  let activeTab = 'code';
  let currentRawScore = 12.5;

  function updatePipelineValues(score: number): void {
    currentRawScore = score;
    const state = computePipeline(score);

    if (valDisplay) valDisplay.textContent = state.rawScore.toFixed(1);
    if (clampDisplay) clampDisplay.textContent = state.clampedScore.toFixed(1);
    if (normDisplay) normDisplay.textContent = state.normalizedRatio.toFixed(2);
    if (tierDisplay) tierDisplay.textContent = state.tier;

    if (inspectorCompiled) {
      inspectorCompiled.textContent = generateCompiledPython(state.rawScore);
    }
  }

  function selectTab(tab: string): void {
    activeTab = tab;
    tabButtons.forEach(btn => {
      const isTarget = btn.getAttribute('data-inspector-tab') === tab;
      btn.classList.toggle('atomos-btn--primary', isTarget);
      btn.classList.toggle('atomos-btn--ghost', !isTarget);
    });

    tabPanes.forEach(pane => {
      pane.style.display = pane.getAttribute('data-tab-pane') === tab ? 'block' : 'none';
    });
  }

  function selectNode(id: string): void {
    const node = EXPLAINER_NODES[id];
    if (!node) return;
    activeNodeId = id;

    nodeCards.forEach(card => {
      const match = card.getAttribute('data-node-id') === id;
      card.style.borderColor = match ? 'var(--strata-interactive)' : 'var(--strata-border)';
      card.style.boxShadow = match ? '0 0 16px rgba(30, 136, 200, 0.35)' : 'none';
    });

    if (inspectorTitle) inspectorTitle.textContent = `fn ${node.name}`;
    if (inspectorSig) inspectorSig.textContent = node.signature;
    if (inspectorLines) inspectorLines.textContent = `${node.lines} / 60 lines (JPL-60 passed)`;
    if (inspectorCode) inspectorCode.textContent = node.code;
    if (inspectorTests) inspectorTests.textContent = node.tests;
    if (inspectorPacket) inspectorPacket.textContent = JSON.stringify(node.packet, null, 2);
    if (inspectorTokens) inspectorTokens.textContent = `${node.packet.tokens} / ${node.packet.budgetLimit} tokens`;

    if (forgeStatus) {
      forgeStatus.style.display = 'none';
      forgeStatus.innerHTML = '';
    }
  }

  // Bind inputs
  if (slider && numInput) {
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      numInput.value = String(val);
      updatePipelineValues(val);
    });

    numInput.addEventListener('input', () => {
      const val = parseFloat(numInput.value) || 0;
      slider.value = String(val);
      updatePipelineValues(val);
    });
  }

  // Bind tabs
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-inspector-tab');
      if (target) selectTab(target);
    });
  });

  // Bind nodes
  nodeCards.forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-node-id');
      if (id) selectNode(id);
    });
  });

  // Walkthrough steps
  const WALKTHROUGH_MESSAGES: Record<string, { nodeId: string; tab: string; text: string }> = {
    '1': {
      nodeId: 'clamp',
      tab: 'code',
      text: 'Step 1: The Atomic Unit (JPL-60). Every function is strictly ≤60 lines, explicitly typed, and contract-checked. No giant bloated files.'
    },
    '2': {
      nodeId: 'normalize',
      tab: 'code',
      text: 'Step 2: Flow Composition. Nodes are wired visually via typed ports (val → score → ratio). Try adjusting the raw score slider above to see data flow live!'
    },
    '3': {
      nodeId: 'clamp',
      tab: 'packet',
      text: 'Step 3: Two-Tier AI Division of Labor. To forge a node body, Slate sends a single micro-packet (≤600 tokens) to local llama.cpp. Zero sliding-context drift!'
    },
    '4': {
      nodeId: 'evaluate_tier',
      tab: 'compiled',
      text: 'Step 4: Deterministic Compilation. The canvas compiles directly to pure, standard Python modules without any LLM guessing glue code.'
    }
  };

  stepButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const step = btn.getAttribute('data-walkthrough-step');
      if (!step || !WALKTHROUGH_MESSAGES[step]) return;

      stepButtons.forEach(b => {
        const isCur = b.getAttribute('data-walkthrough-step') === step;
        b.classList.toggle('atomos-btn--primary', isCur);
        b.classList.toggle('atomos-btn--secondary', !isCur);
      });

      const config = WALKTHROUGH_MESSAGES[step];
      selectNode(config.nodeId);
      selectTab(config.tab);
      if (stepCallout) {
        stepCallout.innerHTML = `<strong>${config.text}</strong>`;
      }
    });
  });

  // Simulate local forge button
  if (simForgeBtn && forgeStatus) {
    simForgeBtn.addEventListener('click', () => {
      const node = EXPLAINER_NODES[activeNodeId];
      forgeStatus.style.display = 'block';
      forgeStatus.innerHTML = `
        <div style="color:var(--strata-info);margin-bottom:6px;">⚡ Dispatching micro-packet (${node.packet.tokens} tokens) to local llama-server...</div>
        <div style="font-family:var(--font-mono);font-size:11px;background:var(--strata-layer-02);padding:8px;border-left:2px solid var(--strata-success);color:var(--strata-text-primary);">
          + def ${node.name}(...):<br>
          +     # Verified candidate generated in 0.42s<br>
          +     pytest: 3 passed · mutmut: 0 survivors (100% mutation score)
        </div>
        <div style="margin-top:6px;display:flex;gap:8px;">
          <button class="atomos-btn atomos-btn--sm atomos-btn--primary" id="sim-accept-btn">✓ Accept Candidate</button>
          <span class="atomos-tag atomos-tag--success" style="align-self:center;">Guardrails Passed</span>
        </div>
      `;

      const acceptBtn = document.getElementById('sim-accept-btn');
      if (acceptBtn) {
        acceptBtn.addEventListener('click', () => {
          forgeStatus.innerHTML = `<div style="color:var(--strata-success);font-weight:600;">✓ Candidate accepted into slate/nodes/${node.id}.json and saved.</div>`;
        });
      }
    });
  }

  // Initial render
  updatePipelineValues(currentRawScore);
  selectNode('clamp');
  selectTab('code');
}

// Auto-run if in browser document
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExplainerStudio);
  } else {
    initExplainerStudio();
  }
}
