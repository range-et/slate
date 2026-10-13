// Pre-build script: Ensure config.js exists (create stub if missing)
// This allows the build to work even when config.js is gitignored

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '../src/config.js');
const defaultConfig = `// Local development config - this file is gitignored
// Set your API keys here for local development
// In production, these will be null and users will set their keys via the UI

const OPENAI_API_KEY = null; // Set your OpenAI API key here: "sk-..."
const GEMINI_API_KEY = null; // Set your Gemini API key here (from Google AI Studio)

export { OPENAI_API_KEY, GEMINI_API_KEY };
`;

if (!fs.existsSync(configPath)) {
    console.log('Creating default config.js stub...');
    fs.writeFileSync(configPath, defaultConfig);
    console.log('✓ config.js created with default (null) value');
} else {
    console.log('✓ config.js already exists');
}

