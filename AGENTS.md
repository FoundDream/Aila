- use Bun for the project
- use Tailwind CSS for styling
- frontend performance principle:
  keep high-frequency state updates scoped to the smallest necessary subtree, and isolate expensive UI subtrees from unrelated updates
- prefer this order:
  first remove unnecessary re-renders with state placement, component boundaries, or memoization; then consider virtualization or heavier optimizations if rendering is still expensive
- when analyzing rendering performance:
  optimize update paths before optimizing component internals; focus on which state changes cause which subtrees to re-render
- component splitting principles:
  prefer splitting by responsibility and state/update boundaries, not just by visual similarity
  extract shared components when structure and behavior are repeated and stable, especially when the parent becomes simpler after extraction
  prefer shared layout/shell primitives over premature business abstraction; avoid components that only stay "shared" through many variants, flags, or conditionals
  keep high-frequency state close to the smallest subtree that needs it, and do not lift state merely to force reuse
  if an extraction makes data flow, naming, or render behavior harder to follow, keep the code local until the pattern becomes clearer
