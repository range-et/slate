# Slate

A graph-based document editor with AI-powered card creation and intelligent reference linking. Organize your thoughts, documents, and AI conversations in an interconnected knowledge graph. The main reason for this interface is to demonstrate that a single line of thought "chat" interface doesn't have to be the default method of brainstorming how we come up with ideas. 

![Slate - Graph-Based Document Editor](https://img.shields.io/badge/status-MVP-blue) ![JavaScript](https://img.shields.io/badge/javascript-ES6-yellow) ![D3.js](https://img.shields.io/badge/d3.js-v7-orange) ![CodeMirror](https://img.shields.io/badge/codemirror-v6-green)

## Overview

Slate is a hierarchical document management system that combines:
- **AI-Assisted Writing**: Generate content using OpenAI's GPT-4o-mini model
- **Graph Visualization**: See your knowledge as an interconnected network
- **Smart References**: Link cards and documents using @mentions with autocomplete
- **Document Summaries**: AI-generated summaries of document content
- **Advanced Editor**: CodeMirror-powered prompt editor with syntax highlighting
- **Cross-Document Context**: Reference cards across different documents

## Features

### 🗂️ Hierarchical Organization
- **Projects** contain **Documents** contain **Cards**
- Navigate your knowledge graph visually
- Click nodes to switch between documents
- See parent-child relationships and cross-references

### 🤖 AI Integration
- Generate content with OpenAI's GPT-4o-mini model
- Include context by @referencing cards and documents
- Automatic bibliography construction from references
- AI-generated document summaries (automatically created when cards are added)
- Reference document summaries instead of individual cards
- Seamless integration with your workflow

### 🔗 Smart Linking & References
- Use `@card_title` to reference any card in your project
- Use `@doc_title` to reference entire document summaries
- **Autocomplete**: Type `@` to see all available cards and documents
- **Syntax Highlighting**: @references appear in cyan color
- Click cards to instantly insert references into your prompt
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

### ✨ Enhanced Editor Experience
- **CodeMirror 6 Integration**: Modern, powerful text editor
- **Real-time Syntax Highlighting**: @references highlighted in cyan
- **Intelligent Autocomplete**: Context-aware suggestions for cards and documents
- **Line Wrapping**: Automatically handles long prompts
- **Keyboard Navigation**: Full keyboard support for autocomplete
- **Visual Feedback**: Immediate visual feedback for references

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
   - Enter a prompt in the CodeMirror editor area
   - Click **SEND** to generate AI response
   - Click **ADD TO DOC** to save as a card
   - Card titles auto-generate or can be customized
   - Document summaries are automatically generated in the background

### Using References with Autocomplete

```
# In your prompt (with autocomplete support):
Summarize the key points from @design_doc and compare with @api_spec

# Type @ to trigger autocomplete:
- See all available cards and documents
- Navigate with arrow keys
- Select with Enter or click

# Slate will automatically:
1. Find the referenced cards or document summaries
2. Include their full content as context
3. Send everything to the AI
4. Track links for visualization
```

### Document Summaries

- **Automatic Generation**: When you add cards, Slate automatically generates a summary
- **Visual Feedback**: The SUMMARY button shows generation status:
  - Pulsing animation while generating
  - Green success indicator when complete
  - Red error indicator if generation fails
- **View Summaries**: Click the **SUMMARY** button to view
- **Reference in Prompts**: Use `@doc_title` to include summary as context

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
│   ├── main_script.js           # Main application manager
│   ├── cards.js                 # Card class & logic
│   ├── doc.js                   # Document class with summary support
│   ├── project.js               # Project class & graph generation
│   ├── ai_chat.js               # Chat manager & AI integration
│   ├── ai_utils.js              # OpenAI API wrapper (GPT-4o-mini)
│   ├── codemirror_setup.js      # CodeMirror editor configuration
│   ├── network_viz.js           # D3.js visualization
│   ├── modal.js                 # Custom modal dialogs
│   ├── random_name_generator.js # Unique name generation
│   ├── config.js                # Configuration
│   ├── styles.css               # Main stylesheet
│   ├── ColorPalette.css         # Color theme
│   └── index.html               # Entry point
├── package.json
└── vite.config.js               # Vite build configuration
```

### Key Classes & Modules

#### `Project`
- Manages collection of documents
- Generates graph data for visualization
- Handles import/export as JSON
- Ensures unique document titles
- Tracks cross-document references

#### `Doc`
- Manages collection of cards
- Tracks document metadata
- **AI-generated summary support** with async generation
- Flattened content extraction for summarization
- Ensures unique card titles
- Serializes to/from JSON with summary data

#### `Card`
- Stores title, content, and links
- Tracks @references to other cards
- Handles DOM creation and removal
- **Click-to-reference functionality** (insert @card_title)
- Parent document relationship tracking

#### `ChatManager`
- Manages AI interactions
- Parses @references from prompts (cards and docs)
- Builds bibliography with card content or doc summaries
- Handles card creation workflow
- **Triggers automatic summary generation** when cards are added
- CodeMirror editor integration

#### `NetworkViz`
- D3.js radial tree visualization
- Interactive node clicking
- Zoom and pan controls
- Styled edges by type (hierarchy vs reference)

#### `CodeMirror Setup`
- Custom theme matching app color scheme
- **@reference syntax highlighting** (cyan color)
- **Autocomplete for @references** (cards and docs)
- Line wrapping and modern editing features
- Helper functions for text manipulation

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
| `Enter` | Send prompt (when in prompt editor) |
| `@` | Trigger autocomplete (cards and docs) |
| `Arrow Keys` | Navigate autocomplete suggestions |
| `Enter` / `Click` | Select autocomplete suggestion |
| `Esc` | Close autocomplete |

## Tips & Tricks

### Building Context
1. Create foundational cards first
2. Reference them in new prompts: `Based on @foundation, explain...`
3. Build knowledge iteratively
4. **Use document summaries** for high-level context: `@doc_title`
5. Export regularly to save your work

### Organizing Projects
- Use documents as chapters or topics
- Keep related cards in the same document
- Use references to connect ideas across documents
- Leverage search to quickly navigate
- **View summaries** to get document overviews

### AI Prompting Best Practices
- **Use autocomplete**: Type `@` to see all available references
- Reference multiple cards for rich context
- **Reference documents** for broader context instead of individual cards
- Cards can reference cards from other documents
- The AI sees the full content of referenced cards or document summaries
- Use descriptive card titles for better reference matching
- **Click cards** to quickly insert references

### Editor Features
- **Syntax highlighting**: @references appear in cyan
- **Autocomplete navigation**: Use arrow keys and Enter
- **Line wrapping**: Long prompts automatically wrap
- **Click to reference**: Click any card to insert its @reference

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
      "summary": "AI-generated summary of document content",
      "cards": [
        {
          "id": "uuid-v4",
          "title": "card_title",
          "content": "<html content>",
          "links": ["referenced_card_1", "referenced_card_2"]
        }
      ],
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601",
      "cardCount": 2
    }
  ],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "docCount": 1,
  "totalCards": 2
}
```

## Technical Details

### Dependencies
- **D3.js v7.9.0**: Network visualization with radial tree layout
- **OpenAI v5.15.0**: AI content generation (GPT-4o-mini model)
- **CodeMirror v6.0.2**: Advanced text editor with autocomplete
- **UUID v11.1.0**: Unique identifier generation
- **Vite v7.1.3**: Build tool and development server

### Browser Compatibility
- Modern browsers (Chrome, Firefox, Safari, Edge)
- Requires ES6+ support
- localStorage for API key storage
- No contenteditable dependencies (uses CodeMirror)

### Performance
- Efficient graph rendering with D3.js
- Incremental updates (no full re-renders)
- Asynchronous summary generation (non-blocking)
- Local-first architecture
- No database required
- Client-side AI API calls

## Roadmap

### Recently Completed ✅
- [x] CodeMirror editor integration with syntax highlighting
- [x] @reference autocomplete for cards and documents
- [x] AI-generated document summaries
- [x] Click-to-reference card functionality
- [x] Visual feedback for summary generation
- [x] Cross-document reference support

### Potential Features
- [ ] Undo/Redo functionality
- [ ] Rich text editing (markdown support in cards)
- [ ] Card templates
- [ ] Tags and filtering
- [ ] Full-text search (beyond titles)
- [ ] Collaborative editing
- [ ] Cloud sync
- [ ] PDF export
- [ ] Graph analytics (in/out degrees, centrality)
- [ ] Custom graph layouts (force-directed, hierarchical)
- [ ] Multiple AI model support (GPT-4, Claude, etc.)
- [ ] Streaming responses
- [ ] Card versioning/history
- [ ] Custom color themes

## Contributing

Contributions welcome! Areas for improvement:
- Additional AI model support (Claude, Gemini, local models)
- Enhanced visualizations (alternative layouts, animations)
- Mobile responsiveness
- Accessibility improvements (ARIA labels, keyboard navigation)
- Performance optimizations (virtual scrolling, lazy loading)
- Rich text editing in cards (markdown, formatting)
- Editor enhancements (multi-cursor, vim mode, themes)
- Document summary customization (length, style)
- Advanced search (full-text, filters, regex)

## License

[Add your license here]

## Acknowledgments

Built with:
- [D3.js](https://d3js.org/) - Data visualization
- [OpenAI](https://openai.com/) - AI language models (GPT-4o-mini)
- [CodeMirror](https://codemirror.net/) - Advanced text editor
- [Vite](https://vitejs.dev/) - Build tool

---

**Note**: This is an MVP (Minimum Viable Product). Features are actively being developed and refined.
