import { COVERAGE, RUNTIMES, stableStrings } from './contracts.js';

/**
 * 驗證單一 obligation 的 changed region 並回傳所有 coverage blocker。
 *
 * @param {object} obligation - 要檢查的 coverage obligation。
 * @returns {string[]} changed region 的穩定 blocker 清單。
 */
function regionBlockers(obligation) {
  const blockers = [];
  const regions = obligation.changedRegions;

  if (!Array.isArray(regions)) {
    return [`${obligation.id}:CHANGED_REGIONS_MISSING`];
  }

  if (regions.length === 0) {
    return [`${obligation.id}:NO_CHANGED_REGIONS`];
  }

  let previousStart = -1;
  let previousEnd = -1;

  for (const region of regions) {
    if (
      !Number.isInteger(region?.startByte)
      || !Number.isInteger(region?.endByte)
      || region.startByte < 0
      || region.endByte <= region.startByte
    ) {
      blockers.push(`${obligation.id}:INVALID_REGION`);
    } else {
      if (region.startByte < previousStart) {
        blockers.push(`${obligation.id}:REGION_ORDER_INVALID`);
      }
      if (region.startByte < previousEnd) {
        blockers.push(`${obligation.id}:REGION_OVERLAP`);
      }
      previousStart = region.startByte;
      previousEnd = Math.max(previousEnd, region.endByte);
    }

    if (typeof region?.path !== 'string' || region.path.trim() === '') {
      blockers.push(`${obligation.id}:PATH_MISSING`);
    }

    if (typeof region?.language !== 'string' || region.language.trim() === '') {
      blockers.push(`${obligation.id}:LANGUAGE_MISSING`);
    }

    if (typeof region?.adapterId !== 'string' || region.adapterId.trim() === '') {
      blockers.push(`${obligation.id}:ADAPTER_MISSING`);
    }

    if (!RUNTIMES.includes(region?.runtime)) {
      blockers.push(`${obligation.id}:RUNTIME_INVALID`);
    } else if (region.runtime === 'unknown') {
      blockers.push(`${obligation.id}:UNKNOWN_RUNTIME`);
    }
  }

  return blockers;
}

/**
 * 評估所有必要 coverage obligation 是否足以進入 reduction。
 *
 * @param {object|undefined} report - normalized coverage report。
 * @returns {{status: string, blockers: string[]}} coverage 狀態與 blocker 清單。
 */
export function evaluateCoverage(report) {
  if (!report || !Array.isArray(report.obligations)) {
    return { status: COVERAGE.FAILED, blockers: ['COVERAGE_MISSING'] };
  }

  const obligations = report.obligations;
  const ids = obligations.map((obligation) => obligation?.id);
  if (new Set(ids).size !== ids.length) {
    return { status: COVERAGE.FAILED, blockers: ['COVERAGE_DUPLICATE_OBLIGATION'] };
  }

  const required = obligations.filter((obligation) => obligation?.required === true);
  if (required.length === 0) {
    return { status: COVERAGE.FAILED, blockers: ['COVERAGE_NO_REQUIRED_OBLIGATIONS'] };
  }

  const blockers = [];
  let failed = false;

  for (const obligation of required) {
    if (obligation.status !== COVERAGE.COMPLETE) {
      const reason = obligation.reasonCode ?? obligation.status ?? 'INCOMPLETE';
      blockers.push(`${obligation.id}:${reason}`);
      failed ||= obligation.status === COVERAGE.FAILED;
      continue;
    }

    blockers.push(...regionBlockers(obligation));
  }

  const uniqueBlockers = stableStrings(blockers);
  if (uniqueBlockers.length > 0) {
    return {
      status: failed ? COVERAGE.FAILED : COVERAGE.INCOMPLETE,
      blockers: uniqueBlockers,
    };
  }

  return { status: COVERAGE.COMPLETE, blockers: [] };
}
