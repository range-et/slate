// Config loader - imports config.js
// config.js is gitignored but has a default stub that exports null
// Users can modify config.js locally without committing their API keys
// Namespace import so partial config (e.g. only OPENAI_API_KEY) still works

import * as config from "./config.js";

export const OPENAI_API_KEY = config.OPENAI_API_KEY ?? null;
export const GEMINI_API_KEY = config.GEMINI_API_KEY ?? null;

