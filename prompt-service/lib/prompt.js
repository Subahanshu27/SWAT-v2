/**
 * Prompt generation helpers — pure functions, no DB writes.
 */

export function isApiPromptShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([, node]) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    return (
      typeof node.class_type === 'string' &&
      typeof node.inputs === 'object' &&
      node.inputs !== null &&
      !Array.isArray(node.inputs)
    );
  });
}

const COMPATIBILITY_DEFAULTS = {
  UltimateSDUpscale: {
    batch_size: 1,
  },
  ResolutionSelector: {
    multiple: 64,
  },
};

function applyCompatibilityDefaults(prompt) {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return prompt;

  let changed = false;
  const repaired = {};
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      repaired[nodeId] = node;
      continue;
    }

    const inputs =
      node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs)
        ? { ...node.inputs }
        : node.inputs;

    const defaults = COMPATIBILITY_DEFAULTS[node.class_type];
    let nodeChanged = false;
    if (defaults && inputs && typeof inputs === 'object') {
      for (const [inputName, defaultValue] of Object.entries(defaults)) {
        if (!(inputName in inputs)) {
          inputs[inputName] = defaultValue;
          nodeChanged = true;
        }
      }
    }

    if (nodeChanged) changed = true;
    repaired[nodeId] = nodeChanged ? { ...node, inputs } : node;
  }

  return changed ? repaired : prompt;
}

function buildLinkMap(links) {
  const byId = new Map();
  if (!Array.isArray(links)) return byId;
  for (const link of links) {
    if (Array.isArray(link)) {
      const [id, originId, originSlot, targetId, targetSlot] = link;
      byId.set(id, {
        origin_id: String(originId),
        origin_slot: originSlot,
        target_id: String(targetId),
        target_slot: targetSlot,
      });
    } else if (link && typeof link === 'object' && link.id != null) {
      byId.set(link.id, {
        origin_id: String(link.origin_id),
        origin_slot: link.origin_slot,
        target_id: String(link.target_id),
        target_slot: link.target_slot,
      });
    }
  }
  return byId;
}

/**
 * Raw ComfyUI UI graph -> API prompt conversion (no compatibility defaults).
 * Approximates browser graphToPrompt() using nodes, links, and widgets_values.
 * Used both for the actual conversion and for computing a graph signature.
 */
function buildRawPromptFromGraph(workflowJson) {
  if (!workflowJson || typeof workflowJson !== 'object') return null;
  const nodes = workflowJson.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const linkById = buildLinkMap(workflowJson.links);
  const prompt = {};

  for (const node of nodes) {
    if (!node?.type || typeof node.type !== 'string') continue;
    // ComfyUI: 2 = never, 4 = bypass
    if (node.mode === 2 || node.mode === 4) continue;

    const nodeId = String(node.id);
    const inputs = {};
    const widgetValues = Array.isArray(node.widgets_values) ? [...node.widgets_values] : [];
    let widgetIndex = 0;

    if (Array.isArray(node.inputs)) {
      for (const input of node.inputs) {
        if (!input?.name) continue;
        if (input.link != null && linkById.has(input.link)) {
          const link = linkById.get(input.link);
          inputs[input.name] = [link.origin_id, link.origin_slot];
        } else if (widgetIndex < widgetValues.length) {
          inputs[input.name] = widgetValues[widgetIndex];
          widgetIndex += 1;
        }
      }
    }

    prompt[nodeId] = { class_type: node.type, inputs };
  }

  return Object.keys(prompt).length > 0 ? prompt : null;
}

/**
 * Convert ComfyUI UI graph (workflow_json) to API prompt shape.
 */
export function convertUiGraphToPrompt(workflowJson) {
  const raw = buildRawPromptFromGraph(workflowJson);
  return raw ? applyCompatibilityDefaults(raw) : null;
}

/**
 * Canonicalize an API-shape prompt into a stable signature string.
 */
function apiPromptSignature(prompt) {
  const nodeIds = Object.keys(prompt).sort();
  const canonical = nodeIds.map((id) => {
    const node = prompt[id] || {};
    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
    const inputEntries = Object.keys(inputs)
      .sort()
      .map((key) => [key, inputs[key]]);
    return [id, node.class_type ?? null, inputEntries];
  });
  return JSON.stringify(canonical);
}

/**
 * Signature of a ComfyUI UI graph derived DIRECTLY from nodes/links, including
 * `widgets_values`. This captures widget/parameter changes and connection
 * changes independently of node definitions (object_info), which the API-prompt
 * approximation cannot see. Ignores incidental UI metadata (positions, sizes,
 * titles, colors, link numbering).
 */
function uiGraphSignature(workflowJson) {
  const nodes = workflowJson?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const linkById = buildLinkMap(workflowJson.links);
  const entries = [];

  for (const node of nodes) {
    if (!node || node.type == null) continue;

    const inputsSig = [];
    if (Array.isArray(node.inputs)) {
      for (const input of node.inputs) {
        if (!input?.name) continue;
        if (input.link != null && linkById.has(input.link)) {
          const link = linkById.get(input.link);
          inputsSig.push([input.name, [link.origin_id, link.origin_slot]]);
        } else {
          inputsSig.push([input.name, null]);
        }
      }
    }
    inputsSig.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    entries.push([
      String(node.id),
      String(node.type),
      node.mode ?? 0,
      node.widgets_values ?? null,
      inputsSig,
    ]);
  }

  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Produce a stable, order-independent signature of a workflow's *functional*
 * graph. Two workflow versions that behave identically yield the same
 * signature; any change to node set, connections, widget values, or bypass
 * state changes it.
 *
 * Accepts either a UI graph ({ nodes, links }) or an API-shape prompt.
 * Returns null when no meaningful graph can be derived.
 */
export function graphSignature(workflowJson) {
  const parsed = parseMaybeJson(workflowJson);
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes)) {
    return uiGraphSignature(parsed);
  }
  if (isApiPromptShape(parsed)) {
    return apiPromptSignature(parsed);
  }
  return null;
}

/**
 * Build a comparable node map from a UI graph: id -> { type, mode, widgets, inputs }.
 */
function buildNodeMap(workflowJson) {
  const nodes = workflowJson?.nodes;
  if (!Array.isArray(nodes)) return null;
  const linkById = buildLinkMap(workflowJson.links);
  const map = new Map();

  for (const node of nodes) {
    if (!node || node.type == null) continue;
    const inputs = [];
    if (Array.isArray(node.inputs)) {
      for (const input of node.inputs) {
        if (!input?.name) continue;
        if (input.link != null && linkById.has(input.link)) {
          const link = linkById.get(input.link);
          inputs.push([input.name, `${link.origin_id}:${link.origin_slot}`]);
        } else {
          inputs.push([input.name, null]);
        }
      }
    }
    inputs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    map.set(String(node.id), {
      type: String(node.type),
      mode: node.mode ?? 0,
      widgets: Array.isArray(node.widgets_values) ? node.widgets_values : [],
      inputs,
    });
  }
  return map;
}

/**
 * Whether two UI graphs are the same *version* for regression purposes.
 *
 * Compares node set, class types, bypass/mute mode, and input connections
 * exactly. For widget values it compares only the overlapping prefix: a
 * successful run's stored graph often carries extra trailing widget defaults
 * (filled in from node definitions) that the saved workflow_json omits — that
 * is not a user change. Any divergence within the shared prefix, or any
 * structural difference, means the workflow actually changed.
 */
function uiGraphsMatch(a, b) {
  const A = buildNodeMap(a);
  const B = buildNodeMap(b);
  if (!A || !B) return false;
  if (A.size !== B.size) return false;

  for (const [id, na] of A) {
    const nb = B.get(id);
    if (!nb) return false;
    if (na.type !== nb.type) return false;
    if (na.mode !== nb.mode) return false;
    if (JSON.stringify(na.inputs) !== JSON.stringify(nb.inputs)) return false;

    const shared = Math.min(na.widgets.length, nb.widgets.length);
    for (let i = 0; i < shared; i++) {
      if (JSON.stringify(na.widgets[i]) !== JSON.stringify(nb.widgets[i])) return false;
    }
  }
  return true;
}

/**
 * Whether two workflow representations describe the same functional graph.
 */
export function graphsMatch(a, b) {
  const pa = parseMaybeJson(a);
  const pb = parseMaybeJson(b);

  if (pa && typeof pa === 'object' && Array.isArray(pa.nodes) && pb && typeof pb === 'object' && Array.isArray(pb.nodes)) {
    return uiGraphsMatch(pa, pb);
  }

  const sigA = graphSignature(pa);
  const sigB = graphSignature(pb);
  return !!sigA && sigA === sigB;
}

/**
 * Add missing class_type to a partial stored prompt using workflow_json node types.
 */
export function repairStoredPrompt(storedPrompt, workflowJson) {
  if (!storedPrompt || typeof storedPrompt !== 'object' || Array.isArray(storedPrompt)) {
    return null;
  }

  const nodesById = new Map();
  for (const n of workflowJson?.nodes || []) {
    if (n?.id != null && n?.type) nodesById.set(String(n.id), n);
  }

  const repaired = {};
  for (const [id, raw] of Object.entries(storedPrompt)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const node = { ...(raw) };
    if (!node.class_type) {
      const graphNode = nodesById.get(id);
      if (graphNode?.type) node.class_type = graphNode.type;
    }
    if (typeof node.class_type !== 'string') continue;
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) continue;
    repaired[id] = { class_type: node.class_type, inputs: node.inputs };
  }

  return Object.keys(repaired).length > 0 ? applyCompatibilityDefaults(repaired) : null;
}

export function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Resolve the best API prompt without any DB writes.
 */
export function resolvePromptLocally({ workflow_json, prompt: storedPrompt }) {
  const workflowJson = parseMaybeJson(workflow_json);
  const stored = parseMaybeJson(storedPrompt);

  if (isApiPromptShape(stored)) {
    return { prompt: applyCompatibilityDefaults(stored), source: 'stored', strategy: 'stored_valid' };
  }

  const repaired = repairStoredPrompt(stored, workflowJson);
  if (repaired && isApiPromptShape(repaired)) {
    const storedCount = stored && typeof stored === 'object' ? Object.keys(stored).length : 0;
    const graphCount = Array.isArray(workflowJson?.nodes) ? workflowJson.nodes.length : 0;
    // Only trust repair when the stored prompt covers the full graph (or graph unknown).
    if (graphCount === 0 || storedCount >= graphCount * 0.8) {
      return { prompt: repaired, source: 'stored', strategy: 'stored_repaired' };
    }
  }

  if (isApiPromptShape(workflowJson)) {
    return {
      prompt: applyCompatibilityDefaults(workflowJson),
      source: 'workflow_json',
      strategy: 'workflow_json_api',
    };
  }

  const converted = convertUiGraphToPrompt(workflowJson);
  if (converted && isApiPromptShape(converted)) {
    return { prompt: converted, source: 'workflow_json', strategy: 'graph_converted' };
  }

  return {
    prompt: null,
    source: 'none',
    strategy: 'failed',
    reason: 'Could not build a valid API prompt from workflow_json or stored prompt',
  };
}
