export const ERR_OPTIMIZE_DEPS_PROCESSING_ERROR =
  "ERR_OPTIMIZE_DEPS_PROCESSING_ERROR";
export const ERR_OUTDATED_OPTIMIZED_DEP = "ERR_OUTDATED_OPTIMIZED_DEP";
export const ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR =
  "ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR";
export function throwOutdatedRequest(id: string): never {
  const err: any = new Error(
    `There is a new version of the pre-bundle for "${id}", ` +
      `a page reload is going to ask for it.`
  );
  err.code = ERR_OUTDATED_OPTIMIZED_DEP;
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err;
}
