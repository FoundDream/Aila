// VertexClient is implemented alongside GoogleClient in ./google.ts because
// both share the same @google/genai SDK. This file is kept as a re-export so
// external imports of './vertex' keep working.
export { VertexClient } from './google'
