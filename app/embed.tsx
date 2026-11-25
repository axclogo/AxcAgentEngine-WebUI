import React from 'react';
import { createRoot } from 'react-dom/client';
import { createHttpClient } from '../src/index';
import '../src/styles.css';
import { EmbedExamples } from '../examples/embed';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <EmbedExamples client={createHttpClient()} />
  </React.StrictMode>,
);
