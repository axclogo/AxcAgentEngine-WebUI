import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentStudio, createHttpClient, type Theme } from '../src/index';
import '../src/styles.css';
import './shell.css';

const client = createHttpClient();
const stored = (localStorage.getItem('axc-theme') as Theme | null) ?? 'system';

function App() {
  const [theme, setTheme] = React.useState<Theme>(stored);
  const resolved =
    theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  return (
    <AgentStudio
      client={client}
      theme={resolved}
      onThemeChange={(t) => {
        localStorage.setItem('axc-theme', t);
        setTheme(t);
      }}
      brand={
        <>
          <span className="font-bold tracking-wide text-primary">AXC</span>
          <span className="text-muted-foreground">Agent Studio</span>
        </>
      }
    />
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
