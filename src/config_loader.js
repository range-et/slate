// Config loader - imports config.js
// config.js is gitignored but has a default stub that exports null
// Users can modify config.js locally without committing their API keys

import { OPENAI_API_KEY, GEMINI_API_KEY } from "./config.js";

// Re-export - will be null by default, or user's API key if they set it locally
export { OPENAI_API_KEY, GEMINI_API_KEY };

