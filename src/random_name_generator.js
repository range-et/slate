// Random name generator for cards (Docker-style)
const adjectives = [
    "happy", "silly", "brave", "clever", "wise", "swift", "bold", "calm",
    "eager", "gentle", "jolly", "kind", "lively", "merry", "noble", "proud",
    "quick", "sharp", "steady", "witty", "zealous", "bright", "cosmic", "daring",
    "epic", "fierce", "graceful", "humble", "inspired", "joyful", "keen", "lucky",
    "mighty", "nimble", "optimal", "peaceful", "quirky", "radiant", "stellar", "thriving",
    "unique", "vibrant", "wonderful", "amazing", "brilliant", "creative", "dynamic", "elegant"
];

const nouns = [
    "panda", "penguin", "tiger", "eagle", "dolphin", "falcon", "wolf", "bear",
    "lion", "hawk", "fox", "owl", "raven", "shark", "whale", "dragon", "phoenix",
    "unicorn", "griffin", "kraken", "sphinx", "hydra", "pegasus", "mantis", "cobra",
    "viper", "panther", "cheetah", "leopard", "jaguar", "cougar", "lynx", "otter",
    "badger", "raccoon", "squirrel", "rabbit", "deer", "moose", "elk", "bison",
    "rhino", "elephant", "giraffe", "zebra", "gazelle", "antelope", "buffalo", "mustang"
];

/**
 * Generate a random Docker-style name (adjective_noun)
 * @returns {string} A random name like "brave_penguin" or "cosmic_dragon"
 */
export function generateRandomName() {
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adjective}_${noun}`;
}

export default generateRandomName;

