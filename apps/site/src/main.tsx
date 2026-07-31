import '@fontsource-variable/familjen-grotesk';
import '@fontsource/fragment-mono';
import '@fontsource/instrument-serif';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Brainstrike site root element was not found.');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
