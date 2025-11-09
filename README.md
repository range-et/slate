# Slate

A graph-based document editor with AI-powered card creation and intelligent reference linking. Organize your thoughts, documents, and AI conversations in an interconnected knowledge graph. The main reason for this interface is to demonstrate that a single line of thought "chat" interface doesn't have to be the default method of brainstorming how we come up with ideas. 

![Slate - Graph-Based Document Editor](https://img.shields.io/badge/status-MVP-blue) ![JavaScript](https://img.shields.io/badge/javascript-ES6-yellow) ![D3.js](https://img.shields.io/badge/d3.js-v7-orange) ![CodeMirror](https://img.shields.io/badge/codemirror-v6-green)

**Live Demo**: [www.slate-notebook.com](https://www.slate-notebook.com)

## Why Slate?

Slate addresses a limitation of current LLM interfaces: LLMs are stateless machines. Most chat interfaces maintain a sliding context window of the last N exchanges, which forgets information when conversations exceed the context length.

Slate provides explicit control over context. Users select which parts of generated content to include as context for the next generation, rather than relying on a sliding window.

[Read the full motivation](motivation.md) for details on the philosophy and approach.

## Overview

Slate is a hierarchical document management system that combines:
- **AI-Assisted Writing**: Generate content using OpenAI's GPT-4o-mini model with vision support
- **Image Support**: Attach or paste images, analyzed by AI using vision capabilities
- **Graph Visualization**: See your knowledge as an interconnected network with intelligent node spacing
- **Smart References**: Link cards and documents using @mentions with autocomplete
- **Document Summaries**: AI-generated summaries of document content
- **Advanced Editor**: CodeMirror-powered prompt editor with syntax highlighting
- **Cross-Document Context**: Reference cards across different documents
- **Card Management**: Move cards between documents

## Features

### 🗂️ Hierarchical Organization
- **Projects** contain **Documents** contain **Cards**
- Navigate your knowledge graph visually
- Click nodes to switch between documents
- See parent-child relationships and cross-references

### 🤖 AI Integration
- Generate content with OpenAI's GPT-4o-mini model
- **Vision API Support**: Send images to AI for analysis and description
- Include context by @referencing cards and documents
- Automatic bibliography construction from references
- AI-generated document summaries (automatically created when cards are added)
- Reference document summaries instead of individual cards
- **Markdown formatting**: All AI responses rendered as markdown
- **Prompt preservation**: Original prompts and images saved with each card
- Integration with your workflow

### 🖼️ Image Support
- **Attach Images**: Click "ATTACH IMAGE" button to select from file system
- **Copy-Paste**: Copy any image and paste directly into the app
- **Multiple Images**: Add multiple images to a single prompt
- **Preview & Remove**: See thumbnails before sending, remove unwanted images
- **Base64 Storage**: Images encoded and stored in JSON (no external file dependencies)
- **AI Vision**: Images sent to OpenAI's vision API for analysis
- **Card Display**: Images preserved and displayed in saved cards
- **Export/Import**: Images included in JSON exports for complete portability

### 🔗 Smart Linking & References
- Use `@card_title` to reference any card in your project
- Use `@doc_title` to reference entire document summaries
- **Project-wide Autocomplete**: Type `@` to see ALL cards from ALL documents
- **Context-aware**: Autocomplete shows which document each card belongs to
- **Syntax Highlighting**: @references appear in green within prompts
- **Clickable Links**: Click @references in card prompts to navigate
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
- Force-directed graph layout with intelligent spacing
- **Advanced Collision Detection**: Nodes never overlap, even with labels
- **Dynamic Spacing**: Automatic node repulsion prevents clustering
- Color-coded node types (project/doc/card)
- Two edge types:
  - **Thick cyan edges**: Hierarchy (parent-child)
  - **Thin red edges**: References (card-to-card links)
- Interactive zoom and pan
- Smooth animations and transitions
- Real-time updates when cards are moved between documents

### ✨ Enhanced Editor Experience
- **CodeMirror 6 Integration**: Text editor with syntax highlighting
- **Real-time Syntax Highlighting**: @references highlighted in cyan
- **Intelligent Autocomplete**: Context-aware suggestions for ALL cards and documents
- **Project-wide Search**: See cards from every document when typing `@`
- **Line Wrapping**: Automatically handles long prompts
- **Keyboard Navigation**: Full keyboard support for autocomplete
- **Visual Feedback**: Immediate visual feedback for references

### 📝 Markdown Support
- **Markdown Formatting**: All content rendered with GitHub Flavored Markdown
- **Neutral Color Scheme**: Grey/white markdown doesn't compete with UI colors
- **Card Prompts**: Original prompts displayed in italics with highlighted @references
- **AI Responses**: Markdown-formatted responses with headings, lists, code blocks
- **Summaries**: Document summaries rendered with full markdown support
- **Live Chat**: Real-time markdown rendering in chat window

## Documentation

- **[Motivation](motivation.md)** - Why Slate exists and the philosophy behind user-controlled context
- **[Deployment Guide](DEPLOYMENT.md)** - How to deploy Slate as a static site
- **[Readme](README.md)** - This file (feature overview and usage guide)

**Live Demo**: [www.slate-notebook.com](https://www.slate-notebook.com)

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
   - **Add Images** (optional):
     - Click "ATTACH IMAGE" button to select files
     - OR copy any image and paste it (Ctrl/Cmd+V)
     - Preview thumbnails appear above the editor
     - Click × on any thumbnail to remove it
   - Use `@` to reference other cards or documents (autocomplete shows ALL cards)
   - Click **SEND** to generate markdown-formatted AI response (with image analysis if images attached)
   - Click **ADD TO DOC** to instantly save as a card (no confirmation needed)
   - Card titles auto-generate or can be customized
   - **Card Structure**: Each card preserves the prompt, images, and response
   - Document summaries are automatically generated in the background

### Managing Cards

1. **View Card Details**:
   - Each card shows the original prompt (with clickable @references)
   - Attached images displayed below the prompt
   - AI response rendered with markdown formatting
   
2. **Move Cards Between Documents**:
   - Click the **↗️** button on any card
   - Select destination document from dropdown
   - Card moves instantly with all content, images, and links preserved
   - Network visualization updates automatically
   
3. **Remove Cards**:
   - Click the **×** button on any card
   - Confirmation required before deletion

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

### Card Anatomy

Each card has three sections:
1. **Card Header**:
   - Card title and unique ID
   - **↗️ Move button**: Relocate card to another document
   - **× Remove button**: Delete card (with confirmation)
   
2. **Prompt Section** (blue-grey, italics):
   - Shows the original prompt that created the card
   - @references are highlighted in green and clickable
   - Click any @reference to navigate to that card
   - **Attached images** displayed as thumbnails
   
3. **Response Section** (markdown-rendered):
   - AI-generated response with full markdown formatting
   - Headings, lists, code blocks, tables, etc.
   - Neutral grey color scheme for readability

### Navigation

- **Search**: Type a title in the search bar, press Enter
- **Click @references**: In card prompts, click green @references to navigate
- **Network Viz**: Click any node (project/doc/card) to navigate
- **Card Nodes**: Click card in graph to jump to its document
- **Doc Switching**: Preserves your current prompt

### Managing Documents

- **New Doc**: `+` button (generates unique random name)
- **Delete Doc**: `-` button (with confirmation)
- **Rename**: Click doc title input, edit, blur to save
- **Switch**: Click doc node in visualization
- **Move Cards**: Use the ↗️ button on cards to move them between documents

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
- Stores title, content, **prompt**, **images**, and links
- **Triple-section rendering**: Header + Prompt (with images) + Response (markdown)
- Tracks @references to other cards
- **Clickable @references**: Navigate by clicking links in prompt
- **Move between documents**: Relocate cards with full data preservation
- Handles DOM creation and removal
- Parent document relationship tracking
- Base64 image storage and rendering
- Markdown rendering for all content

#### `ChatManager`
- Manages AI interactions
- **Image handling**: Attach button, paste events, preview management
- **Base64 encoding**: Converts images for storage and API transmission
- Parses @references from prompts (cards and docs)
- Builds bibliography with card content or doc summaries
- **Markdown rendering**: Converts AI responses to formatted HTML
- Handles card creation workflow with prompt and image preservation
- **Triggers automatic summary generation** when cards are added
- CodeMirror editor integration

#### `NetworkViz`
- D3.js force-directed graph visualization
- **Advanced collision detection**: Prevents node overlap with label padding
- **Dynamic force simulation**: 
  - Strong repulsion forces push nodes apart
  - Collision iterations ensure perfect spacing
  - Text label padding included in collision radius
- **Centered layout**: Graph stays centered during interactions
- Interactive node clicking for navigation
- **Click card nodes**: Jump to card's document
- Zoom and pan controls with smooth transitions
- Styled edges by type (hierarchy vs reference)
- Real-time updates when graph structure changes

#### `CodeMirror Setup`
- Custom theme matching app color scheme
- **@reference syntax highlighting** (cyan color in editor)
- **Project-wide autocomplete**: Shows ALL cards from ALL documents
- **Context indicators**: Shows which document each card belongs to
- Color-coded suggestions (green for cards, blue for docs)
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
| `Ctrl/Cmd + V` | Paste image (when image is in clipboard) |
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
- **Use autocomplete**: Type `@` to see ALL cards from ALL documents
- **Autocomplete shows context**: See which document each card belongs to
- **Add images for visual context**: Copy-paste or attach images for AI to analyze
- **Multiple images supported**: Add diagrams, screenshots, photos for comprehensive analysis
- Reference multiple cards for rich context
- **Reference documents** for broader context instead of individual cards
- The AI sees the full content of referenced cards or document summaries
- Use descriptive card titles for better reference matching
- **AI formats in markdown**: Responses include headings, lists, code, tables

### Working with Images
- **Copy-Paste Workflow**: Copy image from anywhere → Paste in Slate → Preview → Send
- **File Attachment**: Click "ATTACH IMAGE" → Select one or more files → Preview → Send
- **Preview Management**: Review thumbnails before sending, remove unwanted images
- **Storage**: All images stored as base64 in JSON (completely portable)
- **AI Vision**: GPT-4o-mini analyzes image content and incorporates it into responses
- **Card Preservation**: Images saved with cards and displayed in prompt section

### Navigation & Links
- **Click @references in prompts**: Navigate to referenced cards instantly
- **Network graph navigation**: Click any node to jump to that location
- **Search**: Find cards or documents by title (exact or partial match)
- **Card links are green**: Clickable references in prompt sections
- **Preserved prompts**: See the original question that created each card

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
      "summary": "AI-generated markdown summary",
      "cards": [
        {
          "id": "uuid-v4",
          "title": "card_title",
          "content": "<rendered markdown html>",
          "prompt": "Original prompt text with @references",
          "images": [
            {
              "data": "data:image/png;base64,...",
              "mimeType": "image/png",
              "name": "screenshot.png"
            }
          ],
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
- **D3.js v7.9.0**: Network visualization with force-directed layout
- **OpenAI v5.15.0**: AI content generation (GPT-4o-mini model)
- **CodeMirror v6.0.2**: Advanced text editor with autocomplete
- **Marked v11.2.0**: GitHub Flavored Markdown parser and renderer
- **UUID v11.1.0**: Unique identifier generation
- **Vite v7.1.3**: Build tool and development server

### Browser Compatibility
- Modern browsers (Chrome, Firefox, Safari, Edge)
- Requires ES6+ support
- localStorage for API key storage
- No contenteditable dependencies (uses CodeMirror)

### Performance
- Efficient graph rendering with D3.js
- **Optimized force simulation**: 5 collision iterations for perfect node spacing
- Incremental updates with full re-renders only when structure changes
- Asynchronous summary generation (non-blocking)
- Base64 image encoding (no external file I/O)
- Local-first architecture
- No database required
- Client-side AI API calls

## Roadmap

### Recently Completed ✅
- [x] **Image Support** - attach, paste, preview, and send images to AI
- [x] **OpenAI Vision API** - GPT-4o-mini analyzes images
- [x] **Base64 Storage** - images encoded in JSON for portability
- [x] **Move Cards Between Documents** - relocate cards with ↗️ button
- [x] **No Confirmation Popups** - instant card addition
- [x] **Advanced Collision Detection** - prevents node overlap in graph
- [x] **Dynamic Force Simulation** - intelligent node spacing with label padding
- [x] CodeMirror editor integration with syntax highlighting
- [x] @reference autocomplete for cards and documents
- [x] **Project-wide autocomplete** - see ALL cards from ALL documents
- [x] AI-generated document summaries with visual feedback
- [x] **Markdown rendering** for all content (cards, chat, summaries)
- [x] **Prompt preservation** - cards store original prompts
- [x] **Clickable @references** in card prompts for navigation
- [x] **Neutral markdown colors** - grey/white scheme
- [x] Cross-document reference support
- [x] **Centered graph layout** - no jarring translations

### Potential Features
- [ ] Rich text editing (markdown support in cards)
- [ ] Card templates
- [ ] Tags and filtering
- [ ] Full-text search (beyond titles)
- [ ] Image zoom/lightbox in cards
- [ ] Multiple image formats (GIF, WebP, etc.)
- [ ] Drag-and-drop image upload
- [ ] Collaborative editing
- [ ] Cloud sync
- [ ] PDF export (including images)
- [ ] Graph analytics (in/out degrees, centrality)
- [ ] Alternative graph layouts (hierarchical, circular)
- [ ] Multiple AI model support (GPT-4, Claude, etc.)
- [ ] Streaming responses
- [ ] Card versioning/history
- [ ] Bulk card operations

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

## Related Documentation

- **[Motivation](motivation.md)** - Deep dive into why Slate exists and the problems it solves
- **[Deployment Guide](DEPLOYMENT.md)** - Step-by-step deployment instructions for various hosting options

## License

slate notebook editor © 2025 by Indrajeet Haldar is licensed under CC BY-NC-ND 4.0. To view a copy of this license, visit https://creativecommons.org/licenses/by-nc-nd/4.0/

## Acknowledgments

Built with:
- [D3.js](https://d3js.org/) - Data visualization and force-directed graphs
- [OpenAI](https://openai.com/) - AI language models (GPT-4o-mini)
- [CodeMirror](https://codemirror.net/) - Advanced text editor
- [Marked](https://marked.js.org/) - Markdown parser and renderer
- [Vite](https://vitejs.dev/) - Build tool

---

**Note**: This is an MVP (Minimum Viable Product). Features are actively being developed and refined.
