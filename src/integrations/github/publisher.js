import { validateGithubPayload } from './contracts.js';

export const GITHUB_PUBLICATION_FAILED = 'GITHUB_PUBLICATION_FAILED';
export const GITHUB_PUBLICATION_MARKER = 'REVIEW_REDUCTION_SAFETY';

/**
 * 驗證 provider transport 的成功 response，避免 malformed response 被當成成功。
 *
 * @param {unknown} response - transport response。
 * @returns {boolean} response 是否為可接受的 2xx receipt。
 */
function isSuccessfulResponse(response) {
  return Boolean(
    response
    && response.ok === true
    && Number.isInteger(response.status)
    && response.status >= 200
    && response.status < 300
    && typeof response.id === 'string'
    && response.id.trim() !== '',
  );
}

/**
 * 建立不包含 transport exception 的 delivery failure。
 *
 * @returns {{published: false, reason: string}} delivery failure。
 */
function failure() {
  return { published: false, reason: GITHUB_PUBLICATION_FAILED };
}

/**
 * 以 provider-neutral upsert port 發布 authoritative Summary 與 status check。
 *
 * @param {{upsertSummary: function, upsertCheck: function}} transport - 注入的 provider transport。
 * @param {object} payload - 已由 authority 建立的 Summary/check payload。
 * @returns {Promise<{published: boolean, reason?: string, receipt?: object}>} delivery result。
 */
export async function publishGithubResult(transport, payload) {
  if (
    !transport
    || typeof transport.upsertSummary !== 'function'
    || typeof transport.upsertCheck !== 'function'
    || !validateGithubPayload(payload).valid
  ) {
    return failure();
  }

  const request = {
    marker: GITHUB_PUBLICATION_MARKER,
    repository: payload.repository,
    headSha: payload.headSha,
    candidateDigest: payload.candidateDigest,
    summary: payload.summary,
    check: payload.check,
  };

  try {
    const summaryResponse = await transport.upsertSummary(request);
    if (!isSuccessfulResponse(summaryResponse)) return failure();

    const checkResponse = await transport.upsertCheck(request);
    if (!isSuccessfulResponse(checkResponse)) return failure();

    return {
      published: true,
      receipt: {
        summary: summaryResponse,
        check: checkResponse,
      },
    };
  } catch {
    return failure();
  }
}
