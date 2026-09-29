export function deleteBatchResult(ids, result) {
  if (!Array.isArray(result?.failed)) throw new Error('The server did not confirm which files were deleted. Refresh the library before trying again.');
  const failedIds = new Set(result.failed.map(f => f.id));
  const deletedIds = ids.filter(id => !failedIds.has(id));
  if (result.deleted !== deletedIds.length) throw new Error('The server did not confirm which files were deleted. Refresh the library before trying again.');
  const reasons = [...new Set(result.failed.map(f => f.error).filter(Boolean))];
  return {
    deletedIds,
    failed: result.failed,
    error: result.failed.length
      ? `${result.deleted} deleted; ${result.failed.length} could not be deleted and remain in the library.${reasons.length ? ' ' + reasons.join('; ') : ''}`
      : '',
  };
}
