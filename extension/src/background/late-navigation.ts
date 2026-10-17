/** A click that saw no change, or a key press that submitted a form, may still be followed by a
 * script navigation. An action that opened a new tab already has its observed outcome. */
export function watchesLateNavigation(result: any): boolean {
  const verified = result?.verified;
  if (!verified || result?.openedTabs?.length) return false;
  return (verified.urlChanged === false && verified.domChanged === false) || verified.submitted === true;
}
