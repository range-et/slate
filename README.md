# Slate

A graph-based document editor with AI-powered card creation and intelligent reference linking. Organize your thoughts, documents, and AI conversations in an interconnected knowledge graph. The main reason for this interface is to demonstrate that a single line of thought "chat" interface doesnt have to be the default method of brainstorming how we come up with ideas. 

![Slate - Graph-Based Document Editor](https://img.shields.io/badge/status-MVP-blue) ![JavaScript](https://img.shields.io/badge/javascript-ES6-yellow) ![D3.js](https://img.shields.io/badge/d3.js-v7-orange)

## Overview

Slate is a hierarchical document management system that combines:
- **AI-Assisted Writing**: Generate content using OpenAI's GPT models
- **Graph Visualization**: See your knowledge as an interconnected network
- **Smart References**: Link cards together using @mentions
- **Cross-Document Context**: Reference cards across different documents

## Features

### 🗂️ Hierarchical Organization
- **Projects** contain **Documents** contain **Cards**
- Navigate your knowledge graph visually
- Click nodes to switch between documents
- See parent-child relationships and cross-references

### 🤖 AI Integration
- Generate content with OpenAI's GPT models
- Include context by @referencing other cards
- Automatic bibliography construction from references
- Seamless integration with your workflow

### 🔗 Smart Linking
- Use `@card_title` to reference any card in your project
- Click cards to insert references into your prompt
- Directed graph edges show relationships
- Cross-document references supported

### 🔍 Search & Navigation
- Search by document or card title
- Partial matching support
- Auto-scroll and highlight results
- Keyboard shortcuts (Enter to search)

### 💾 Import/Export
- Save entire projects as JSON
- Preserve all structure, content, and links
- Load projects back with full fidelity
- Portable and shareable

### 🎨 Visual Network
- Radial tree layout visualization
- Color-coded node types (project/doc/card)
- Two edge types:
  - **Thick cyan edges**: Hierarchy (parent-child)
  - **Thin red edges**: References (card-to-card links)
- Interactive zoom and pan

## Quick Start

### Prerequisites
- Node.js (v14+)
- npm or yarn
- OpenAI API key (optional, for AI features)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd slate

# Install dependencies
npm install

# Start development server
npm run dev
```

### Configuration

1. Click the **API KEY** button in the top bar
2. Enter your OpenAI API key
3. Key is stored locally in browser storage
4. Fallback to `config.js` if not set

## Usage Guide

### Creating Content

1. **Create a New Project**: Auto-generated on first load
2. **Add Documents**: Click the `+` button
3. **Generate Cards**:
   - Enter a prompt in the chat area
   - Click **SEND** to generate AI response
   - Click **ADD TO DOC** to save as a card

### Using References

```
# In your prompt:
Summarize the key points from @design_doc and compare with @api_spec

# Slate will automatically:
1. Find the referenced cards
2. Include their full content as context
3. Send everything to the AI
4. Track links for visualization
```

### Navigation

- **Search**: Type a title in the search bar, press Enter
- **Click Cards**: Add `@card_title` to your prompt
- **Network Viz**: Click nodes to switch documents/cards
- **Doc Switching**: Preserves your current prompt

### Managing Documents

- **New Doc**: `+` button (generates unique random name)
- **Delete Doc**: `-` button (with confirmation)
- **Rename**: Click doc title input, edit, blur to save
- **Switch**: Click doc node in visualization

## Architecture

### Project Structure

```
Project (Root Node)
  ├── Document 1
  │     ├── Card A
  │     ├── Card B → [references Card C]
  │     └── Card C
  ├── Document 2
  │     ├── Card D → [references Card A]
  │     └── Card E
  └── ...
```

### File Organization

```
slate/
├── src/
│   ├── main_script.js      # Main application manager
│   ├── cards.js             # Card class & logic
│   ├── doc.js               # Document class
│   ├── project.js           # Project class & graph generation
│   ├── ai_chat.js           # Chat manager & AI integration
│   ├── ai_utils.js          # OpenAI API wrapper
│   ├── network_viz.js       # D3.js visualization
│   ├── modal.js             # Custom modal dialogs
│   ├── random_name_generator.js
│   ├── config.js
│   ├── styles.css
│   └── index.html
└── package.json
```

### Key Classes

#### `Project`
- Manages collection of documents
- Generates graph data for visualization
- Handles import/export as JSON
- Ensures unique document titles

#### `Doc`
- Manages collection of cards
- Tracks document metadata
- Ensures unique card titles
- Serializes to/from JSON

#### `Card`
- Stores title, content, and links
- Tracks @references to other cards
- Handles DOM creation and removal
- Click-to-reference functionality

#### `ChatManager`
- Manages AI interactions
- Parses @references from prompts
- Builds bibliography with card content
- Handles card creation workflow

#### `NetworkViz`
- D3.js radial tree visualization
- Interactive node clicking
- Zoom and pan controls
- Styled edges by type

## Title Naming Rules

All titles are automatically sanitized:
- Lowercase only
- Spaces replaced with underscores
- Special characters removed
- Example: `"My Cool Card!"` → `"my_cool_card"`

### Uniqueness
- **Random titles**: Re-generated if duplicate exists
- **User titles**: Appended with `_1`, `_2`, etc.
- Applies to both documents and cards

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Search (when in search box) |
| `Enter` | Send prompt (when in prompt box) |

## Tips & Tricks

### Building Context
1. Create foundational cards first
2. Reference them in new prompts: `Based on @foundation, explain...`
3. Build knowledge iteratively
4. Export regularly to save your work

### Organizing Projects
- Use documents as chapters or topics
- Keep related cards in the same document
- Use references to connect ideas across documents
- Leverage search to quickly navigate

### AI Prompting
- Reference multiple cards for rich context
- Cards can reference cards from other documents
- The AI sees the full content of referenced cards
- Use descriptive card titles for better reference matching

## Data Format

### Export JSON Structure

```json
{
  "id": "uuid-v4",
  "name": "project_name",
  "docs": [
    {
      "id": "uuid-v4",
      "title": "doc_title",
      "cards": [
        {
          "id": "uuid-v4",
          "title": "card_title",
          "content": "<html content>",
          "links": ["referenced_card_1", "referenced_card_2"]
        }
      ],
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601"
    }
  ],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

## Technical Details

### Dependencies
- **D3.js**: Network visualization
- **OpenAI API**: Content generation
- **UUID**: Unique identifiers
- **Vite**: Build tool and dev server

### Browser Compatibility
- Modern browsers (Chrome, Firefox, Safari, Edge)
- Requires ES6+ support
- localStorage for API key storage
- contenteditable for rich text input

### Performance
- Efficient graph rendering with D3.js
- Incremental updates (no full re-renders)
- Local-first architecture
- No database required

## Roadmap

### Potential Features
- [ ] Undo/Redo functionality
- [ ] Rich text editing (markdown support)
- [ ] Card templates
- [ ] Tags and filtering
- [ ] Full-text search (beyond titles)
- [ ] Collaborative editing
- [ ] Cloud sync
- [ ] PDF export
- [ ] Graph analytics (in/out degrees, centrality)
- [ ] Custom graph layouts (force-directed, hierarchical)

## Contributing

Contributions welcome! Areas for improvement:
- Additional AI model support
- Enhanced visualizations
- Mobile responsiveness
- Accessibility improvements
- Performance optimizations

## License

[Add your license here]

## Acknowledgments

Built with:
- [D3.js](https://d3js.org/) - Data visualization
- [OpenAI](https://openai.com/) - AI language models
- [Vite](https://vitejs.dev/) - Build tool

---

**Note**: This is an MVP (Minimum Viable Product). Features are actively being developed and refined.
