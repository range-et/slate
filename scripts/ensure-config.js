// Pre-build script: Ensure config.js exists (create stub if missing)
// This allows the build to work even when config.js is gitignored

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '../src/config.js');
const defaultConfig = `// Local development config - this file is gitignored
// Set your OpenAI API key here for local development
// In production, this will be null and users will set their key via the UI

const OPENAI_API_KEY = null; // Set your API key here: "sk-..."

export { OPENAI_API_KEY };
`;

if (!fs.existsSync(configPath)) {
    console.log('Creating default config.js stub...');
    fs.writeFileSync(configPath, defaultConfig);
    console.log('✓ config.js created with default (null) value');
} else {
    console.log('✓ config.js already exists');
}

