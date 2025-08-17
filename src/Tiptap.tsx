import { Color } from '@tiptap/extension-color'
import ListItem from '@tiptap/extension-list-item'
import TextStyle from '@tiptap/extension-text-style'
import { EditorProvider, useCurrentEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import './Tiptap.css'

const MenuBar = () => {
  const { editor } = useCurrentEditor()

  if (!editor) {
    return null
  }

  // Read the current editor's state, and re-render the component when it changes
  const editorState = useEditorState({
    editor,
    selector: ctx => {
      return {
        isBold: ctx.editor.isActive('bold') ?? false,
        canBold: ctx.editor.can().chain().toggleBold().run() ?? false,
        isItalic: ctx.editor.isActive('italic') ?? false,
        canItalic: ctx.editor.can().chain().toggleItalic().run() ?? false,
        isStrike: ctx.editor.isActive('strike') ?? false,
        canStrike: ctx.editor.can().chain().toggleStrike().run() ?? false,
        isCode: ctx.editor.isActive('code') ?? false,
        canCode: ctx.editor.can().chain().toggleCode().run() ?? false,
        canClearMarks: ctx.editor.can().chain().unsetAllMarks().run() ?? false,
        isParagraph: ctx.editor.isActive('paragraph') ?? false,
        isHeading1: ctx.editor.isActive('heading', { level: 1 }) ?? false,
        isHeading2: ctx.editor.isActive('heading', { level: 2 }) ?? false,
        isHeading3: ctx.editor.isActive('heading', { level: 3 }) ?? false,
        isHeading4: ctx.editor.isActive('heading', { level: 4 }) ?? false,
        isHeading5: ctx.editor.isActive('heading', { level: 5 }) ?? false,
        isHeading6: ctx.editor.isActive('heading', { level: 6 }) ?? false,
        isBulletList: ctx.editor.isActive('bulletList') ?? false,
        isOrderedList: ctx.editor.isActive('orderedList') ?? false,
        isCodeBlock: ctx.editor.isActive('codeBlock') ?? false,
        isBlockquote: ctx.editor.isActive('blockquote') ?? false,
        canUndo: ctx.editor.can().chain().undo().run() ?? false,
        canRedo: ctx.editor.can().chain().redo().run() ?? false,
        isPurple: ctx.editor.isActive('textStyle', { color: '#958DF1' }) ?? false,
      }
    },
  })

  return (
    <div className="control-group">
      <div className="button-group">
          <button
            onClick={() => editor.chain().focus().toggleBold().run()}
            disabled={!editorState.canBold}
            className={editorState.isBold ? 'is-active' : ''}
            title="Bold"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="3" y="15" fontWeight="bold" fontSize="16" fill="currentColor">B</text></svg>
          </button>
          <button
            onClick={() => editor.chain().focus().toggleItalic().run()}
            disabled={!editorState.canItalic}
            className={editorState.isItalic ? 'is-active' : ''}
            title="Italic"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="5" y="15" fontStyle="italic" fontSize="16" fill="currentColor">I</text></svg>
          </button>
          <button
            onClick={() => editor.chain().focus().toggleStrike().run()}
            disabled={!editorState.canStrike}
            className={editorState.isStrike ? 'is-active' : ''}
            title="Strike"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="2" y="15" fontSize="16" fill="currentColor" textDecoration="line-through">S</text><line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" strokeWidth="2"/></svg>
          </button>
          <button
            onClick={() => editor.chain().focus().toggleCode().run()}
            disabled={!editorState.canCode}
            className={editorState.isCode ? 'is-active' : ''}
            title="Code"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="2" y="15" fontSize="16" fill="currentColor">&lt;/&gt;</text></svg>
          </button>
        <button 
          onClick={() => editor.chain().focus().unsetAllMarks().run()}
          disabled={!editorState.canClearMarks} 
          title="Clear marks"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" fill="none"/><line x1="6" y1="6" x2="14" y2="14" stroke="currentColor" strokeWidth="2"/><line x1="14" y1="6" x2="6" y2="14" stroke="currentColor" strokeWidth="2"/></svg>
        </button>
        <button onClick={() => editor.chain().focus().clearNodes().run()} title="Clear nodes">
          <svg width="20" height="20" viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none"/><line x1="4" y1="4" x2="16" y2="16" stroke="currentColor" strokeWidth="2"/></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().setParagraph().run()}
          className={editorState.isParagraph ? 'is-active' : ''}
          title="Paragraph"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><text x="2" y="15" fontSize="16" fill="currentColor">¶</text></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 as any }).run()}
          className={editorState.isHeading1 ? 'is-active' : ''}
          title="Heading 1"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><text x="2" y="15" fontSize="16" fill="currentColor">H1</text></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 as any }).run()}
          className={editorState.isHeading2 ? 'is-active' : ''}
          title="Heading 2"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><text x="2" y="15" fontSize="16" fill="currentColor">H2</text></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 as any }).run()}
          className={editorState.isHeading3 ? 'is-active' : ''}
          title="Heading 3"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><text x="2" y="15" fontSize="16" fill="currentColor">H3</text></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 4 as any }).run()}
          className={editorState.isHeading4 ? 'is-active' : ''}
          title="Heading 4"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><text x="2" y="15" fontSize="16" fill="currentColor">H4</text></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 5 as any }).run()}
          className={editorState.isHeading5 ? 'is-active' : ''}
          title="Heading 5"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><text x="2" y="15" fontSize="16" fill="currentColor">H5</text></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 6 as any }).run()}
          className={editorState.isHeading6 ? 'is-active' : ''}
          title="Heading 6"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><text x="2" y="15" fontSize="16" fill="currentColor">H6</text></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={editorState.isBulletList ? 'is-active' : ''}
          title="Bullet list"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="6" cy="10" r="2" fill="currentColor"/><rect x="10" y="9" width="6" height="2" fill="currentColor"/></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={editorState.isOrderedList ? 'is-active' : ''}
          title="Ordered list"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><text x="2" y="15" fontSize="16" fill="currentColor">1.</text><rect x="10" y="9" width="6" height="2" fill="currentColor"/></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          className={editorState.isCodeBlock ? 'is-active' : ''}
          title="Code block"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><rect x="3" y="5" width="14" height="10" stroke="currentColor" strokeWidth="2" fill="none"/><text x="5" y="15" fontSize="12" fill="currentColor">{`{}`}</text></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={editorState.isBlockquote ? 'is-active' : ''}
          title="Blockquote"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><text x="2" y="15" fontSize="16" fill="currentColor">""</text></svg>
        </button>
        <button onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">
          <svg width="20" height="20" viewBox="0 0 20 20"><line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" strokeWidth="2"/></svg>
        </button>
        <button onClick={() => editor.chain().focus().setHardBreak().run()} title="Hard break">
          <svg width="20" height="20" viewBox="0 0 20 20"><rect x="8" y="8" width="4" height="4" fill="currentColor"/></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editorState.canUndo}
          title="Undo"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><path d="M7 10l-4-4v8l4-4zm2 0h7" stroke="currentColor" strokeWidth="2" fill="none"/></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editorState.canRedo}
          title="Redo"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><path d="M13 10l4-4v8l-4-4zm-2 0H4" stroke="currentColor" strokeWidth="2" fill="none"/></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().setColor('#958DF1').run()}
          className={editorState.isPurple ? 'is-active' : ''}
          title="Purple"
        >
          <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#958DF1" stroke="currentColor" strokeWidth="2"/></svg>
        </button>
      </div>
      <br />
      <hr />
    </div>
  )
}

const extensions = [
  Color.configure({ types: [TextStyle.name, ListItem.name] }),
  TextStyle.configure(),
  StarterKit.configure({
    bulletList: {
      keepMarks: true,
      keepAttributes: false, // TODO : Making this as `false` becase marks are not preserved when I try to preserve attrs, awaiting a bit of help
    },
    orderedList: {
      keepMarks: true,
      keepAttributes: false, // TODO : Making this as `false` becase marks are not preserved when I try to preserve attrs, awaiting a bit of help
    },
  }),
]

const content = `
<h2>
  Hi there,
</h2>
<p>
  this is a <em>basic</em> example of <strong>Tiptap</strong>. Sure, there are all kind of basic text styles you’d probably expect from a text editor. But wait until you see the lists:
</p>
<ul>
  <li>
    That’s a bullet list with one …
  </li>
  <li>
    … or two list items.
  </li>
</ul>
<p>
  Isn’t that great? And all of that is editable. But wait, there’s more. Let’s try a code block:
</p>
<pre><code class="language-css">body {
  display: none;
}</code></pre>
<p>
  I know, I know, this is impressive. It’s only the tip of the iceberg though. Give it a try and click a little bit around. Don’t forget to check the other examples too.
</p>
<blockquote>
  Wow, that’s amazing. Good work, boy! 👏
  <br />
  — Mom
</blockquote>
`

export default () => {
  return (
    <EditorProvider slotBefore={<MenuBar />} extensions={extensions} content={content}></EditorProvider>
  )
}