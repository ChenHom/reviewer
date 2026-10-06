/**
 * 驗證 Historical PR snapshot manifest。
 *
 * humanConcerns 只做 analysis 完成後的 comparison ground truth，
 * 不得傳入 Adapter / interpreter。
 *
 * @param {unknown} value - manifest payload。
 * @returns {{valid: boolean, errors: string[]}} validation result。
 */
export function validateHistoricalManifest(value) {
  const errors = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, errors: ['HISTORICAL_MANIFEST_INVALID'] };
  }

  for (const field of ['id', 'repository', 'baseSha', 'headSha', 'sourceType']) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      errors.push(`HISTORICAL_${field.toUpperCase()}_MISSING`);
    }
  }
  if (!['fixture', 'historical'].includes(value.sourceType)) {
    errors.push('HISTORICAL_SOURCE_TYPE_INVALID');
  }

  if (!Array.isArray(value.files) || value.files.length === 0) {
    errors.push('HISTORICAL_FILES_MISSING');
  } else {
    const paths = value.files.map((file) => file?.path);
    if (new Set(paths).size !== paths.length) errors.push('HISTORICAL_FILE_DUPLICATE_PATH');

    for (const file of value.files) {
      const label = typeof file?.path === 'string' ? file.path : 'unknown';
      if (typeof file?.path !== 'string' || file.path.trim() === '') {
        errors.push('HISTORICAL_FILE_PATH_MISSING');
      }
      if (typeof file?.beforeFile !== 'string' || file.beforeFile.trim() === '') {
        errors.push(`HISTORICAL_BEFORE_FILE_MISSING:${label}`);
      }
      if (typeof file?.afterFile !== 'string' || file.afterFile.trim() === '') {
        errors.push(`HISTORICAL_AFTER_FILE_MISSING:${label}`);
      }
    }
  }

  if (!Array.isArray(value.humanConcerns)) {
    errors.push('HISTORICAL_HUMAN_CONCERNS_MISSING');
  } else {
    const ids = value.humanConcerns.map((concern) => concern?.id);
    if (new Set(ids).size !== ids.length) errors.push('HISTORICAL_CONCERN_DUPLICATE_ID');

    const changedPaths = new Set(
      Array.isArray(value.files) ? value.files.map((file) => file?.path) : [],
    );
    for (const concern of value.humanConcerns) {
      const label = typeof concern?.id === 'string' ? concern.id : 'unknown';
      if (typeof concern?.id !== 'string' || concern.id.trim() === '') {
        errors.push('HISTORICAL_CONCERN_ID_MISSING');
      }
      if (typeof concern?.path !== 'string' || concern.path.trim() === '') {
        errors.push(`HISTORICAL_CONCERN_PATH_MISSING:${label}`);
      } else if (!changedPaths.has(concern.path)) {
        errors.push(`HISTORICAL_CONCERN_PATH_UNKNOWN:${label}`);
      }
    }
  }

  const stableErrors=[...new Set(errors)].sort();
  return { valid: stableErrors.length === 0, errors: stableErrors };
}
