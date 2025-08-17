import './App.css'
import Tiptap from './Tiptap'
import 'flexlayout-react/style/dark.css'
import { Model, Layout, Actions, DockLocation } from 'flexlayout-react'
import type { ITabSetRenderValues, IBorderLocation } from 'flexlayout-react'
import { useRef } from 'react'
import Navbar from './Navbar'
import TopBar from './Topbar'


// FlexLayout configuration
const json = {
  global: {
    "tabEnablePopout": true,
    "splitterEnableHandle": true,
    "tabSetMinWidth": 130,
    "tabSetMinHeight": 100,
    "borderMinSize": 100,
    "tabSetEnableTabScrollbar": true,
    "borderEnableTabScrollbar": true
  },
  borders: [
    {
      "type": "border",
      "location": "left",
      "size": 250,
      "children": [
        {
          "type": "tab",
          "name": "Navigation",
          "component": "navigation",
          "enableClose": false,
        }
      ]
    },
    {
      "type": "border",
      "location": "bottom",
      "children": [
        {
          "type": "tab",
          "name": "JSON",
          "component": "json",
          "enableClose": false,
        }
      ]
    },
  ],
  layout: {
    type: "row",
    weight: 100,
    children: [
      {
        type: "tabset",
        weight: 33,
        children: [
          {
            type: "tab",
            name: "Panel One",
            component: "placeholder",
          }
        ]
      },
      {
        type: "tabset",
        weight: 67,
        children: [
          {
            type: "tab",
            name: "Editor",
            component: "tiptap-editor",
          }
        ]
      }
    ]
  }
};

const model = Model.fromJson(json as any);

function App() {
  // Reference to the layout component for programmatic control
  const layoutRef = useRef(null);

  const factory = (node: any) => {
    const component = node.getComponent();
    
    if (component === "placeholder") {
      return <div className="panel-content">{node.getName()}</div>;
    }
    
    if (component === "tiptap-editor") {
      return <Tiptap />;
    }
    
    if (component === "navigation") {
      return <Navbar />;
    }
    
    if (component === "json") {
      return <div className="json-viewer">JSON Content Here</div>;
    }
  }

  return (
    <div className="app-container">
      <TopBar />
      <div className="layout-container">
        <Layout
          ref={layoutRef}
          model={model}
          factory={factory}
        />
      </div>
    </div>
  )
}

export default App
