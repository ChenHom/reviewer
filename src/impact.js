import { stableStrings } from './contracts.js';
import { provenanceKey, validateProvenance } from './evidence.js';

/**
 * 建立 impact edge 的 stable identity。
 *
 * @param {object} edge - impact edge。
 * @returns {string} edge identity。
 */
function edgeKey(edge) {
  return JSON.stringify([
    edge.source,
    edge.target,
    edge.kind,
    provenanceKey(edge.provenance),
  ]);
}

/**
 * 評估 impact graph 是否能覆蓋 policy 要求的 subjects。
 *
 * @param {{nodes?: object[], edges?: object[], requiredSubjects?: string[]}} [input={}] - impact facts。
 * @returns {{valid: boolean, blockers: string[], nodes: object[], edges: object[]}} impact evaluation result。
 */
export function evaluateImpact({ nodes = [], edges = [], requiredSubjects = [] } = {}) {
  const blockers = [];
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeEdges = Array.isArray(edges) ? edges : [];
  const safeRequiredSubjects = Array.isArray(requiredSubjects) ? requiredSubjects : [];

  if (!Array.isArray(nodes)) blockers.push('IMPACT_NODES_INVALID');
  if (!Array.isArray(edges)) blockers.push('IMPACT_EDGES_INVALID');
  if (!Array.isArray(requiredSubjects)) blockers.push('IMPACT_REQUIRED_SUBJECTS_INVALID');

  const nodeIds = safeNodes.map((node) => node?.id);
  const nodeSet = new Set(nodeIds.filter((id) => typeof id === 'string' && id.trim() !== ''));
  if (nodeIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
    blockers.push('IMPACT_NODE_INVALID');
  }
  if (new Set(nodeIds).size !== nodeIds.length) blockers.push('IMPACT_DUPLICATE_NODE');

  const uniqueEdges = [];
  const uniqueEdgeKeys = new Set();
  const declaredSubjects = new Set();
  for (const edge of safeEdges) {
    if (typeof edge?.source === 'string') declaredSubjects.add(edge.source);
    if (typeof edge?.target === 'string') declaredSubjects.add(edge.target);

    const valid = (
      typeof edge?.source === 'string'
      && typeof edge.target === 'string'
      && nodeSet.has(edge.source)
      && nodeSet.has(edge.target)
      && typeof edge.kind === 'string'
      && edge.kind.trim() !== ''
      && validateProvenance(edge.provenance)
    );
    if (!valid) {
      blockers.push('IMPACT_EDGE_UNRESOLVED');
      continue;
    }

    const key = edgeKey(edge);
    if (!uniqueEdgeKeys.has(key)) {
      uniqueEdgeKeys.add(key);
      uniqueEdges.push(edge);
    }
  }

  for (const subject of safeRequiredSubjects) {
    if (typeof subject !== 'string' || !declaredSubjects.has(subject)) {
      blockers.push('IMPACT_SUBJECT_UNRESOLVED');
    }
  }

  return {
    valid: blockers.length === 0,
    blockers: stableStrings(blockers),
    nodes: safeNodes,
    edges: uniqueEdges,
  };
}
