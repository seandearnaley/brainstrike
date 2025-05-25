import React from 'react';
import ReactDOM from 'react-dom/client';
import '../renderer/styles.css';

function App() {
  return (
    <div className="flex items-center justify-center h-screen">
      <h1 className="text-2xl font-bold">BrainStrike Desktop</h1>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
