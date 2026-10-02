export const defineSite = (site) => site;
/**
 * Typed endpoint helper. Two arguments on purpose: the schemas in the first fix the types before TypeScript checks
 * the strategies in the second, so `request: (input) => …` and `parse` are fully typed without annotations.
 */
export const endpoint = (schemas, rest) => ({ ...schemas, ...rest });
//# sourceMappingURL=site.js.map