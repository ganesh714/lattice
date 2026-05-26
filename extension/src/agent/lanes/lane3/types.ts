/**
 * Lane 3 Multi-Agent Pipeline — Shared Types
 * 
 * These interfaces define the data contracts between each agent in the pipeline:
 *   Step 0 (TaskDecomposer) → Agent 1 (ContextReader) → Agent 2 (ArchExtractor)
 *   → Agent 3 (Planner) → Agent 4 (Critic) → Human-in-the-Loop → Lane 2 Execution
 */

/** Output of Step 0: Task Decomposer — converts a vague prompt into a structured search plan */
export interface SearchPlan {
    /** Keywords to grep/search for in the codebase (e.g., "login", "auth", "jwt") */
    search_terms: string[];
    /** Directories to prioritize reading (e.g., "src/auth/", "services/") */
    likely_dirs: string[];
    /** Class/function/variable names extracted from the user's prompt */
    key_entities: string[];
}

/** Architecture info extracted from a single file */
export interface FileArchitecture {
    /** Relative path to the file */
    filePath: string;
    /** Exported function, class, and interface names */
    exports: string[];
    /** Raw import statements */
    imports: string[];
    /** Full interface/type definitions (verbatim, not paraphrased) */
    interfaces: string[];
    /** Important const/let/var declarations with their types */
    keyVariables: string[];
}

/** Output of Agent 2: Architecture Extractor — structured map of the codebase */
export interface ArchitectureMap {
    /** Per-file architecture breakdown */
    files: FileArchitecture[];
    /** Cross-file dependency chains discovered (e.g., "AuthService → DatabaseClient → config") */
    dependencies: string[];
}

/** Shared context bundle passed to both Agent 3 (Planner) AND Agent 4 (Critic) */
export interface SharedContextBundle {
    /** Raw code chunks with file paths, as gathered by Agent 1 */
    rawCodeChunks: string[];
    /** Structured architecture map from Agent 2 */
    architectureMap: ArchitectureMap;
    /** The original user prompt */
    userPrompt: string;
    /** The search plan from Step 0 */
    searchPlan: SearchPlan;
}

/** Result from the Critic agent review */
export interface CriticResult {
    approved: boolean;
    feedback?: string;
}
