const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const source = path.resolve(extensionRoot, '..', 'python-engine');
const destination = path.join(extensionRoot, 'python-engine');

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(source, 'pyproject.toml'), path.join(destination, 'pyproject.toml'));
fs.cpSync(path.join(source, 'src'), path.join(destination, 'src'), { recursive: true });
