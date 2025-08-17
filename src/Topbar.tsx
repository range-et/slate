const TopBar = () => {
    return (
      <div className="top-bar">
        <div className="logo">MyApp</div>
        <div className="menu">
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Help</span>
        </div>
        <div className="actions">
          <button>Settings</button>
          <button>Profile</button>
        </div>
      </div>
    );
  };

  export default TopBar;